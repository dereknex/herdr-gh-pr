#!/usr/bin/env bun
import { resolvePane } from "../src/main";
import { branchInfo, detailText, fetchSnapshot } from "../src/pr";
import { readState, type PaneCache } from "../src/state";
import { loadConfig } from "../src/config";
import { displayLines, sanitizeTerminalText } from "../src/display";

async function details(): Promise<string> {
  const pane = await resolvePane(process.env.GH_PR_TARGET_PANE);
  if (!pane) return "No target pane or working directory.";
  const info = await branchInfo(pane.cwd);
  if (!info) return "Not on a git branch.";
  const previous = readState<PaneCache>("pane", pane.paneId);
  const cache = previous?.root === info.root && previous.branch === info.branch ? previous : undefined;
  try {
    loadConfig(info.root);
    const snapshot = await fetchSnapshot(info.root, info.branch);
    if (!snapshot) return "No PR for this branch.";
    const live = await resolvePane(pane.paneId);
    const branch = live ? await branchInfo(live.cwd) : null;
    if (branch?.root !== info.root || branch.branch !== info.branch) throw new Error("Pane changed branch during refresh");
    return `${detailText(snapshot)}\n\nDelivery: ${cache?.snapshot?.url === snapshot.url ? cache.delivery || "No submission recorded in this pane" : "No submission recorded"}${cache?.error ? `\nPrevious refresh error: ${cache.error}` : ""}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Refresh failed: ${message}\n\n${cache?.snapshot ? `Previous result (may be stale)\n${detailText(cache.snapshot)}` : "No previous result."}`;
  }
}

async function main(): Promise<void> {
  let text = "Loading PR details...";
  if (!process.stdin.isTTY || !process.stdout.isTTY) { console.log(sanitizeTerminalText(await details())); return; }
  let offset = 0;
  const render = () => {
    const lines = displayLines(text, Math.max(10, (process.stdout.columns || 80) - 2));
    const height = Math.max(1, (process.stdout.rows || 24) - 2);
    offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - height)));
    process.stdout.write(`\x1b[2J\x1b[H${lines.slice(offset, offset + height).join("\r\n")}\r\n\r\n↑/↓ j/k PgUp/PgDn scroll | q/Esc close | ${offset + 1}/${lines.length}`);
  };
  const cleanup = () => { process.stdin.setRawMode(false); process.stdout.write("\x1b[?25h\x1b[?1049l"); };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  process.on("exit", cleanup);
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  process.stdout.on("resize", render);
  process.stdin.on("data", (data) => {
    const key = data.toString();
    if (["q", "\x1b", "\x03"].includes(key)) process.exit(0);
    if (["j", "\x1b[B"].includes(key)) offset++;
    if (["k", "\x1b[A"].includes(key)) offset--;
    if ([" ", "\x1b[6~"].includes(key)) offset += Math.max(1, (process.stdout.rows || 24) - 2);
    if (["b", "\x1b[5~"].includes(key)) offset -= Math.max(1, (process.stdout.rows || 24) - 2);
    render();
  });
  render();
  text = await details();
  render();
}
main().catch((error) => { console.error(`[gh-pr] ${error}`); process.exit(1); });
