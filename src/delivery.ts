import { $ } from "bun";
import { renderPrompt, type Config } from "./config";
import { branchInfo, digest, fetchSnapshot, issuesFor, promptValues, type Snapshot, type Issue } from "./pr";
import { emptyDelivery, readState, writeState, type DeliveryState } from "./state";
import { resolvePaneCwd } from "./label";

const herdr = () => process.env.HERDR_BIN_PATH || "herdr";
export interface Agent {
  pane_id: string;
  name?: string;
  agent?: string;
  agent_status: string;
  cwd?: string;
  foreground_cwd?: string;
  revision: number;
  agent_session?: unknown;
  interactive_ready?: boolean;
}

export async function herdrJson(args: string[]): Promise<any> {
  const out = await $`${herdr()} ${args}`.nothrow().quiet();
  if (out.exitCode !== 0) throw new Error(out.stderr.toString().trim() || `herdr exited ${out.exitCode}`);
  const response = JSON.parse(out.stdout.toString());
  if (response.error) throw new Error(response.error.message);
  return response.result;
}

export function deliveryKey(s: Snapshot): string {
  return `${process.env.HERDR_SOCKET_PATH ?? "default"}:${s.root}:${s.url}`;
}

// Removing an issue clears its sent marker; a later recurrence is a new version.
export function reconcile(state: DeliveryState, issues: Issue[]): string[] {
  const active = Object.fromEntries(issues.map(i => [i.key, state.active[i.key] ?? 1]));
  state.active = active;
  state.sent = state.sent.filter(key => key in active);
  return issues.filter(i => !state.sent.includes(i.key)).map(i => i.key);
}

export function chooseRecipient(agents: Agent[], recipient: string): Agent | null {
  if (recipient) return agents.find(a => a.pane_id === recipient || a.name === recipient) ?? null;
  return agents.length === 1 ? agents[0] : null;
}

async function matchingAgents(s: Snapshot): Promise<Agent[]> {
  const result = await herdrJson(["agent", "list"]);
  if (!Array.isArray(result.agents)) throw new Error("Invalid agent list");
  const matched: Agent[] = [];
  for (const agent of result.agents as Agent[]) {
    const cwd = resolvePaneCwd(agent);
    if (!cwd || !agent.agent) continue;
    const info = await branchInfo(cwd);
    if (info?.root === s.root && info.branch === s.branch) matched.push(agent);
  }
  return matched;
}

export async function sendRepair(s: Snapshot, config: Config, manual: boolean): Promise<string> {
  const key = deliveryKey(s);
  const state = readState<DeliveryState>("delivery", key) ?? emptyDelivery();
  const issues = issuesFor(s, config);
  const fresh = reconcile(state, issues);
  const save = (status: string) => { state.status = status; writeState("delivery", key, state); return status; };
  if (!issues.length) return save("no triggering issues");
  if (!manual && !config.auto_send) return save("auto-send disabled");
  if (!manual && state.pendingAttempt) return save("delivery result unknown; inspect the agent and retry manually");
  if (!manual && !fresh.length) return save(state.status || "issues already sent");
  if (!manual && Date.now() - state.lastAttempt < config.cooldown_seconds * 1000) return save("cooldown in progress");
  const candidates = await matchingAgents(s);
  const agent = chooseRecipient(candidates, config.recipient);
  if (!agent) return save(candidates.length > 1 && !config.recipient ? "recipient selection needed" : "no matching agent");
  const live = (await herdrJson(["agent", "get", agent.pane_id])).agent as Agent;
  const cwd = live && resolvePaneCwd(live);
  const info = cwd ? await branchInfo(cwd) : null;
  if (!live?.agent || live.pane_id !== agent.pane_id || live.agent !== agent.agent || digest(live.agent_session) !== digest(agent.agent_session) || info?.root !== s.root || info.branch !== s.branch) return save("agent or branch changed; refresh again");
  if (!["idle", "done"].includes(live.agent_status) || live.interactive_ready === false) return save(`waiting for agent (${live.agent_status})`);
  const verified = await fetchSnapshot(s.root, s.branch);
  if (!verified || verified.url !== s.url || verified.headRefOid !== s.headRefOid || digest(issuesFor(verified, config)) !== digest(issues)) return save("issues changed; refresh again");
  const finalAgent = (await herdrJson(["agent", "get", agent.pane_id])).agent as Agent;
  const finalCwd = finalAgent && resolvePaneCwd(finalAgent);
  const finalBranch = finalCwd ? await branchInfo(finalCwd) : null;
  if (!finalAgent?.agent || finalAgent.agent !== live.agent || digest(finalAgent.agent_session) !== digest(live.agent_session) || finalBranch?.root !== s.root || finalBranch.branch !== s.branch || !["idle", "done"].includes(finalAgent.agent_status) || finalAgent.interactive_ready === false) return save("agent state changed; refresh again");
  const head = await $`git -C ${s.root} rev-parse HEAD`.nothrow().quiet();
  if (head.exitCode !== 0 || head.stdout.toString().trim() !== s.headRefOid) return save("local HEAD differs from PR head; sync first");
  const currentPr = await $`gh pr view ${s.number} --json headRefOid,state`.cwd(s.root).nothrow().quiet();
  if (currentPr.exitCode !== 0) throw new Error(currentPr.stderr.toString().trim() || "Unable to revalidate PR");
  const pr = JSON.parse(currentPr.stdout.toString());
  if (pr.state !== "OPEN" || pr.headRefOid !== s.headRefOid) return save("PR changed; refresh again");
  const text = renderPrompt(config.prompt, promptValues(verified, issues));
  state.pendingAttempt = manual ? issues.map(i => i.key) : fresh;
  state.lastAttempt = Date.now();
  save("sending");
  try {
    const result = await herdrJson(["agent", "prompt", live.pane_id, text]);
    if (result.type !== "agent_prompted") throw new Error("Unrecognized prompt response");
    state.sent = [...new Set([...state.sent, ...issues.map(i => i.key)])];
    delete state.pendingAttempt;
    return save(`prompt submitted (${live.name || live.pane_id}); the agent reports the repair outcome`);
  } catch (error) {
    // A failed transport can follow a successful PTY write. Keep the attempt and
    // require explicit manual retry rather than silently submitting twice.
    save("delivery result unknown; inspect the agent and retry manually");
    throw error;
  }
}
