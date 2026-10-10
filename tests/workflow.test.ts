import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { acquireLock, statePath } from "../src/state";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Exercise the real entry and persistence through CLI fixtures. Git is real;
// herdr and gh are local executables, so no live agent receives test prompts.
test("refresh, prompt delivery, dedup, error recovery, branch targeting and detail action", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-pr-workflow-"));
  const repo = join(dir, "repo"), bin = join(dir, "bin"), config = join(dir, "config");
  for (const path of [repo, bin, config]) mkdirSync(path);
  const git = async (...args: string[]) => {
    const proc = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    if (await proc.exited) throw new Error(await new Response(proc.stderr).text());
    return output.trim();
  };
  try {
    await git("init", "-b", "feature");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "fixture");
    const head = await git("rev-parse", "HEAD");
    const fixturePath = join(dir, "fixture.json");
    const fixture: any = { repo, head, status: "idle", agents: 1, check: "fail", body: "Fix test", noPr: false, ghFail: false, promptFail: false, requestChanges: false };
    const save = () => writeFileSync(fixturePath, JSON.stringify(fixture));
    const log = join(dir, "commands.jsonl");
    const command = `#!${process.execPath}
import { readFileSync, appendFileSync, existsSync } from "node:fs";
const f = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const args = process.argv.slice(2);
const kind = process.argv[1].endsWith("herdr") ? "herdr" : "gh";
appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ kind, args }) + "\\n");
const pr = {number:7,state:"OPEN",url:"https://github.com/o/r/pull/7",title:"fixture",headRefOid:f.head,mergeable:"MERGEABLE",reviewDecision:"REVIEW_REQUIRED"};
const agent = id => ({ pane_id:id, name:id, agent:"codex",agent_status:f.status,cwd:f.repo,revision:1,interactive_ready:true });
const result = value => console.log(JSON.stringify(kind === "herdr" ? {result:value} : value));
if(kind === "herdr") {
  if(args[0] === "pane" && ["current","get"].includes(args[1])) result({pane:agent(args[2] || "p1")});
  else if(args[0] === "agent" && args[1] === "list") result({agents:Array.from({length:f.agents},(_,i)=>agent("p"+(i+1)))});
  else if(args[0] === "agent" && args[1] === "get") result({agent:agent(args[2])});
  else if(args[0] === "agent" && args[1] === "prompt") {
    if(f.promptFail) {console.error("transport failed after possible submission");process.exit(1);}
    result({type:"agent_prompted",agent:agent(args[2])});
  } else result({type:"ok"});
} else {
  if(f.ghFail) {console.error("HTTP 503 fixture");process.exit(1);}
  if(args[0] === "pr" && args[1] === "view") {
    if(f.noPr) {console.error('no pull requests found for branch "feature"');process.exit(1);}
    if(f.switchBranch) { const p = Bun.spawnSync(["git","-C",f.repo,"checkout","-B","other"]); if(p.exitCode) process.exit(2); }
    result(pr);
  } else if(args[0] === "pr" && args[1] === "checks") {
    if(f.check === "none") {console.error('no checks reported on the feature branch');process.exit(1);}
    result([{name:"test",bucket:f.check,state:f.check,workflow:"CI",link:"https://ci/1",startedAt:"now",completedAt:"now"}]);
    if(f.check === "fail") process.exit(1);
  } else if(args[0] === "api" && args.includes("graphql")) {
    const node = {id:"t",isResolved:false,isOutdated:false,path:"file.ts",line:2,comments:{pageInfo:{hasNextPage:false},nodes:[{id:"c",author:{login:"bot"},body:f.body,url:"https://comment",updatedAt:"today"}]}};
    result([{data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false},nodes:[node]}}}}}]);
  } else if(args[0] === "api") result([f.requestChanges ? [{id:3,state:"CHANGES_REQUESTED",user:{login:"human"},body:"fix",html_url:"url",submitted_at:"today"},{id:4,state:"COMMENTED",user:{login:"human"},body:"more",html_url:"url2",submitted_at:"later"}] : []]);
  else { console.error("unexpected command");process.exit(2); }
}
`;
    for (const name of ["herdr", "gh"]) writeFileSync(join(bin, name), command, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HERDR_BIN_PATH: join(bin, "herdr"), HERDR_PLUGIN_STATE_DIR: join(dir, "state"), HERDR_PLUGIN_CONFIG_DIR: config, HERDR_SOCKET_PATH: "fixture", FIXTURE: fixturePath, COMMAND_LOG: log };
    const entry = resolve(import.meta.dir, "../src/main.ts");
    const execute = async (code = 'await run("p1", true)') => {
      save();
      const proc = Bun.spawn([process.execPath, "-e", `import {run,openDetails} from ${JSON.stringify(entry)}; ${code}`], { env, stdout: "pipe", stderr: "pipe" });
      const err = await new Response(proc.stderr).text();
      return { exit: await proc.exited, err };
    };
    const calls = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const prompts = () => calls().filter(c => c.kind === "herdr" && c.args[0] === "agent" && c.args[1] === "prompt");
    const labels = () => calls().filter(c => c.args.includes("--token")).map(c => c.args.at(-1));
    expect((await execute()).exit).toBe(0);
    expect(prompts()).toHaveLength(0);
    expect(labels().at(-1)).toContain("CI ✗1");
    const ghCount = calls().filter(c => c.kind === "gh").length;
    expect((await execute('await run("p1", false)')).exit).toBe(0);
    expect(calls().filter(c => c.kind === "gh")).toHaveLength(ghCount);
    writeFileSync(join(config, "config.toml"), "auto_send = true\ncooldown_seconds = 0\n");
    fixture.status = "working";
    expect((await execute()).exit).toBe(0);
    expect(prompts()).toHaveLength(0);
    expect(labels().at(-1)).toContain("queued");
    fixture.status = "idle";
    expect((await execute()).exit).toBe(0);
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0].args[3]).toContain("Fix test");
    expect((await execute('await run("p2", true)')).exit).toBe(0);
    expect(prompts()).toHaveLength(1);
    expect((await execute('await run("p1", true, true)')).exit).toBe(0);
    expect(prompts()).toHaveLength(2);
    fixture.body = "Changed feedback";
    fixture.agents = 2;
    expect((await execute()).exit).toBe(0);
    expect(prompts()).toHaveLength(2);
    expect(labels().at(-1)).toContain("recipient needed");
    writeFileSync(join(config, "config.toml"), 'auto_send = true\ncooldown_seconds = 0\nrecipient = "p2"\n');
    expect((await execute()).exit).toBe(0);
    expect(prompts()).toHaveLength(3);
    expect(prompts().at(-1).args[2]).toBe("p2");
    fixture.ghFail = true;
    expect((await execute()).exit).toBe(1);
    expect(labels().at(-1)).toContain("#7");
    expect(labels().at(-1)).toContain("error");
    fixture.ghFail = false;
    fixture.body = "Another feedback";
    fixture.promptFail = true;
    expect((await execute()).exit).toBe(1);
    const attempted = prompts().length;
    fixture.promptFail = false;
    expect((await execute()).exit).toBe(0);
    expect(prompts()).toHaveLength(attempted);
    expect(labels().at(-1)).toContain("sent?");
    fixture.noPr = true;
    expect((await execute()).exit).toBe(0);
    expect(calls().at(-1).args).toContain("--clear-token");
    fixture.noPr = false;
    writeFileSync(join(config, "config.toml"), "auto_send = false\n");
    fixture.check = "none";
    fixture.requestChanges = true;
    expect((await execute()).exit).toBe(0);
    expect(labels().at(-1)).toContain("Review 1/1");
    expect((await execute('await openDetails("p1")')).exit).toBe(0);
    expect(calls().at(-1).args).toContain("GH_PR_TARGET_PANE=p1");
    const detail = Bun.spawn([process.execPath, resolve(import.meta.dir, "../bin/details.ts")], { env: {...env, GH_PR_TARGET_PANE:"p1"}, stdout:"pipe", stderr:"pipe" });
    const text = await new Response(detail.stdout).text();
    expect(await detail.exited).toBe(0);
    expect(text).toContain(fixture.body);
    expect(text).toContain("file.ts:2");
    // One issue persists while another disappears and recurs in later processes.
    const recurrenceState = join(dir, "recurrence-state");
    env.HERDR_PLUGIN_STATE_DIR = recurrenceState;
    writeFileSync(join(config, "config.toml"), 'auto_send = true\ncooldown_seconds = 0\nrecipient = "p2"\n');
    fixture.check = "fail";
    fixture.requestChanges = false;
    expect((await execute()).exit).toBe(0);
    const first = prompts().length;
    fixture.check = "pass";
    expect((await execute()).exit).toBe(0);
    expect(prompts()).toHaveLength(first);
    fixture.check = "fail";
    expect((await execute()).exit).toBe(0);
    expect(prompts()).toHaveLength(first + 1);
    fixture.body = "cooldown feedback";
    writeFileSync(join(config, "config.toml"), 'auto_send = true\nrecipient = "p2"\n');
    expect((await execute()).exit).toBe(0);
    expect(prompts()).toHaveLength(first + 1);
    fixture.status = "blocked";
    expect((await execute('await run("p1", true, true)')).exit).toBe(0);
    expect(prompts()).toHaveLength(first + 1);
    fixture.status = "idle";
    fixture.head = "different-remote-head";
    expect((await execute('await run("p1", true, true)')).exit).toBe(0);
    expect(prompts()).toHaveLength(first + 1);
    fixture.head = head;
    fixture.switchBranch = true;
    expect((await execute()).exit).toBe(1);
    expect(calls().at(-1).args).toContain("--clear-token");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
