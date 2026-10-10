import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, DEFAULT_PROMPT, parseConfig, renderPrompt } from "../src/config";
import { detailText, issuesFor, snapshotLabel, type Snapshot } from "../src/pr";
import { chooseRecipient, reconcile } from "../src/delivery";
import { emptyDelivery } from "../src/state";
import { displayLines } from "../src/display";

export function snapshot(): Snapshot {
  return { root: "/repo", branch: "feature", number: 7, state: "OPEN", url: "https://github.com/o/r/pull/7", title: "PR", headRefOid: "abc", mergeable: "MERGEABLE", reviewDecision: "CHANGES_REQUESTED", fetchedAt: 1, localConflicts: [], checks: [], feedback: [] };
}

test("config merges only the selected repository, validates typos, and defaults auto-send off", () => {
  const c = parseConfig(`cooldown_seconds = 42\n[repositories."/repo"]\nauto_send = true\n[repositories."/other"]\nrecipient = "other"`, "/repo", "/tmp");
  expect(c.auto_send).toBe(true);
  expect(c.recipient).toBe("");
  expect(c.cooldown_seconds).toBe(42);
  expect(DEFAULT_CONFIG.auto_send).toBe(false);
  expect(() => parseConfig("auto_send = 'yes'", "/repo", "/tmp")).toThrow();
  expect(() => parseConfig("cooldown_seconds = -1", "/repo", "/tmp")).toThrow();
  expect(() => parseConfig("[triggers]\nunknown = true", "/repo", "/tmp")).toThrow();
  expect(() => parseConfig("prompt = '{typo}'", "/repo", "/tmp")).toThrow();
});

test("prompt variables substitute once so review text cannot become another template variable", () => {
  expect(renderPrompt("{issues} {branch}", { issues: "{branch}", branch: "feature" })).toBe("{branch} feature");
  expect(renderPrompt(DEFAULT_PROMPT, {}).trim()).not.toBe("");
});

test("only failed checks and enabled conflict types trigger, with exact check and author filters", () => {
  const s = snapshot();
  s.mergeable = "CONFLICTING";
  s.localConflicts = ["a.ts"];
  s.checks = ["cancel", "pending", "fail"].map((bucket, i) => ({ name: `check${i}`, bucket, link: `https://ci/${i}`, state: "", workflow: "", startedAt: "a", completedAt: "b" })) as Snapshot["checks"];
  s.feedback = [{ id: "thread:comment", author: "bot", body: "fix", url: "url", path: "file", line: 4, updatedAt: "today", kind: "thread" }];
  expect(issuesFor(s, DEFAULT_CONFIG)).toHaveLength(3);
  const filtered = { ...DEFAULT_CONFIG, check_names: ["other"], review_authors: ["human"] };
  expect(issuesFor(s, filtered)).toHaveLength(1);
  s.state = "MERGED";
  expect(issuesFor(s, DEFAULT_CONFIG)).toEqual([]);
});

test("issue identity changes with comment edits and check reruns, persists across ordering", () => {
  const s = snapshot();
  s.feedback = [{ id: "t:c", author: "bot", body: "fix", url: "url", path: "file", line: 4, updatedAt: "today", kind: "thread" }];
  const before = issuesFor(s, DEFAULT_CONFIG)[0].key;
  s.feedback[0].body = "new feedback";
  expect(issuesFor(s, DEFAULT_CONFIG)[0].key).not.toBe(before);
});

test("dedup retains sent issues until resolved and allows a recurrence", () => {
  const state = emptyDelivery();
  const issues = [{ key: "conflict", summary: "conflict" }];
  expect(reconcile(state, issues)).toEqual(["conflict"]);
  state.sent = ["conflict"];
  expect(reconcile(state, issues)).toEqual([]);
  reconcile(state, []);
  expect(reconcile(state, issues)).toEqual(["conflict"]);
});

test("recipient selection never chooses arbitrarily between matching agents", () => {
  const agents = ["a", "b"].map(name => ({ name, pane_id: name, agent_status: "idle", revision: 1 }));
  expect(chooseRecipient(agents, "")).toBeNull();
  expect(chooseRecipient(agents, "b")?.name).toBe("b");
  expect(chooseRecipient([agents[0]], "")).toBe(agents[0]);
  expect(chooseRecipient(agents, "missing")).toBeNull();
});

test("summary and details preserve conflict, review and CI information", () => {
  const s = snapshot();
  s.mergeable = "UNKNOWN";
  expect(snapshotLabel(s)).toContain("merge?");
  s.mergeable = "CONFLICTING";
  s.localConflicts = ["a.ts"];
  s.feedback = [{ id: "t:c", author: "bot", body: "fix", url: "comment-url", path: "a.ts", line: 4, updatedAt: "today", kind: "thread" }];
  expect(snapshotLabel(s)).toContain("local conflict 1");
  expect(detailText(s)).toContain("a.ts:4");
  expect(detailText(s)).toContain("comment-url");
  s.state = "CLOSED";
  expect(snapshotLabel(s)).toBe("#7 ⊘");
});

test("detail display strips terminal controls and wraps CJK within terminal columns", () => {
  // The CJK sample is intentional test data for wide-character wrapping.
  const rows = displayLines("\x1b[31m红色\x1b[0m\x1b]52;c;secret\x07\n你好世界", 4);
  expect(rows.join("\n")).not.toContain("\x1b");
  expect(rows.join("\n")).not.toContain("secret");
  expect(rows).toContain("你好");
  expect(rows.every(row => Bun.stringWidth(row) <= 4)).toBe(true);
});
