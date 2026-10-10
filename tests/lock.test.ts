import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, statePath } from "../src/state";

const WORKER = `
const dir = process.argv[2];
process.env.HERDR_PLUGIN_STATE_DIR = dir;
const { acquireLock } = await import(${JSON.stringify(new URL("../src/state.ts", import.meta.url).pathname)});
const lock = acquireLock("concurrent-key");
if (!lock) { console.log("denied"); process.exit(0); }
console.log("acquired");
await Bun.sleep(200);
lock();
process.exit(0);
`;

test("concurrent hooks elect exactly one lock holder and a dead owner is recoverable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-pr-lock-test-"));
  try {
    const worker = join(dir, "worker.ts");
    writeFileSync(worker, WORKER);
    for (let round = 0; round < 2; round++) {
      const workers = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, worker, dir], { stdout: "pipe", stderr: "pipe" }));
      let acquired = 0;
      for (const w of workers) {
        const out = await new Response(w.stdout).text();
        const err = await new Response(w.stderr).text();
        if ((await w.exited) !== 0) throw new Error(`worker crashed: ${err}`);
        if (out.trim() === "acquired") acquired++;
      }
      expect(acquired).toBe(1);
    }
    const dead = statePath("lock", "dead-owner");
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, "owner.json"), JSON.stringify({ pid: 99999999, token: "gone" }));
    const recovered = acquireLock("dead-owner");
    expect(typeof recovered).toBe("function");
    expect(recovered).not.toBeNull();
    recovered?.();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
