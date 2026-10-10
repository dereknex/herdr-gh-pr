import { $ } from "bun";
import { parsePrNumber, refreshingLabel, resolvePaneCwd } from "./label";
import { lastCheckMs, recordCheck, THROTTLE_WINDOW_MS, throttleElapsed } from "./throttle";
import { loadConfig } from "./config";
import { herdrJson, sendRepair, deliveryKey } from "./delivery";
import { branchInfo, fetchSnapshot, snapshotLabel, ghJson, type Snapshot } from "./pr";
import { acquireLock, readState, writeState, type PaneCache } from "./state";

const herdr = () => process.env.HERDR_BIN_PATH || "herdr";
interface Pane { paneId: string; cwd: string; currentStatus?: string }
export async function resolvePane(targetPaneId?: string): Promise<Pane | null> {
  const result = await herdrJson(targetPaneId ? ["pane", "get", targetPaneId] : ["pane", "current"]);
  const pane = result.pane;
  const cwd = pane && resolvePaneCwd(pane);
  if (!pane?.pane_id || !cwd) return null;
  return { paneId: pane.pane_id, cwd, currentStatus: pane.tokens?.pr };
}

export async function setLabel(paneId: string, text: string): Promise<void> {
  const safe = Array.from(text.replace(/[\x00-\x1f\x7f]/g, " ")).slice(0, 80).join("");
  await herdrJson(["pane", "report-metadata", paneId, "--source", "gh-pr", "--token", `pr=${safe}`]);
}
async function clearLabel(paneId: string): Promise<void> {
  await herdrJson(["pane", "report-metadata", paneId, "--source", "gh-pr", "--clear-token", "pr"]);
}

function statusLabel(s: Snapshot, delivery: string): string {
  const marker = delivery.startsWith("prompt submitted") ? "sent" : delivery === "recipient selection needed" ? "recipient needed" : /^(waiting for agent|cooldown)/.test(delivery) ? "queued" : delivery.startsWith("delivery result unknown") ? "sent?" : "";
  return [snapshotLabel(s), marker].filter(Boolean).join(" · ");
}

export async function run(targetPaneId?: string, force = false, manualSend = false): Promise<void> {
  const pane = await resolvePane(targetPaneId);
  if (!pane) return;
  const unlockPane = acquireLock(`pane:${process.env.HERDR_SOCKET_PATH}:${pane.paneId}`);
  if (!unlockPane) {
    if (force) throw new Error("A refresh is already running for this pane; retry after it finishes");
    return;
  }
  try {
    const info = await branchInfo(pane.cwd);
    if (!info) { await clearLabel(pane.paneId); writeState("pane", pane.paneId, { root: "", branch: "" }); return; }
    const old = readState<PaneCache>("pane", pane.paneId);
    const sameBranch = old?.root === info.root && old.branch === info.branch;
    if (!force && sameBranch && !throttleElapsed(lastCheckMs(pane.paneId), Date.now(), THROTTLE_WINDOW_MS)) return;
    recordCheck(pane.paneId, Date.now());
    let snapshot: Snapshot | null = null;
    try {
      // Read config on every actual refresh, including when there is no PR.
      const config = loadConfig(info.root);
      const previous = sameBranch ? parsePrNumber(pane.currentStatus) : null;
      if (previous !== null) await setLabel(pane.paneId, refreshingLabel(previous));
      else await setLabel(pane.paneId, "PR ⟳");
      snapshot = await fetchSnapshot(info.root, info.branch);
      const livePane = await resolvePane(pane.paneId);
      const current = livePane ? await branchInfo(livePane.cwd) : null;
      if (current?.root !== info.root || current.branch !== info.branch) throw new Error("Pane changed branch during refresh; refresh again");
      if (!snapshot) {
        await clearLabel(pane.paneId);
        writeState("pane", pane.paneId, { ...info });
        if (manualSend) throw new Error("The branch has no PR");
        return;
      }
      writeState("pane", pane.paneId, { ...info, snapshot });
      const unlockPr = acquireLock(`pr:${deliveryKey(snapshot)}`);
      if (!unlockPr && manualSend) throw new Error("Another PR prompt evaluation is running; retry after it finishes");
      let delivery = "";
      if (unlockPr) {
        try { delivery = await sendRepair(snapshot, config, manualSend); }
        finally { unlockPr(); }
      }
      writeState("pane", pane.paneId, { ...info, snapshot, delivery });
      await setLabel(pane.paneId, statusLabel(snapshot, delivery));
      if (manualSend) {
        await herdrJson(["notification", "show", "PR repair prompt", "--body", delivery]);
        console.log(`[gh-pr] ${delivery}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const live = await resolvePane(pane.paneId);
      const current = live ? await branchInfo(live.cwd) : null;
      if (current?.root !== info.root || current.branch !== info.branch) {
        writeState("pane", pane.paneId, current ?? { root: "", branch: "" });
        await clearLabel(pane.paneId);
      } else {
        const retained = snapshot ?? (sameBranch ? old?.snapshot : undefined);
        writeState("pane", pane.paneId, { ...info, snapshot: retained, error: message });
        await setLabel(pane.paneId, retained ? `${snapshotLabel(retained)} · error` : "PR error");
      }
      throw error;
    }
  } finally { unlockPane(); }
}

export async function openPr(targetPaneId?: string): Promise<void> {
  const pane = await resolvePane(targetPaneId);
  if (!pane) return;
  const info = await branchInfo(pane.cwd);
  if (!info) return;
  const opened = await $`gh pr view ${info.branch} --web`.cwd(info.root).nothrow().quiet();
  if (opened.exitCode === 0) return;
  const pr = await ghJson(["pr", "view", info.branch, "--json", "url"], info.root);
  await herdrJson(["notification", "show", "PR ready", "--body", pr.url]);
  console.error(`[gh-pr] could not open a browser, PR URL: ${pr.url}`);
}

export async function openDetails(targetPaneId?: string): Promise<void> {
  const pane = await resolvePane(targetPaneId);
  if (!pane) return;
  // Showing details refreshes data without causing an implicit repair submission.
  await herdrJson(["plugin", "pane", "open", "--plugin", "gh-pr", "--entrypoint", "details", "--target-pane", pane.paneId, "--cwd", pane.cwd, "--env", `GH_PR_TARGET_PANE=${pane.paneId}`, "--focus"]);
}
