import { $ } from "bun";
import { createHash } from "node:crypto";
import type { PullRequestState } from "./label";
import type { Config } from "./config";

export interface PrCheck {
  name: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
  state: string;
  link: string;
  workflow: string;
  startedAt: string;
  completedAt: string;
}
export interface Feedback {
  id: string;
  author: string;
  body: string;
  url: string;
  path: string;
  line: number | null;
  updatedAt: string;
  kind: "thread" | "changes_requested";
}
export interface Snapshot {
  root: string;
  branch: string;
  number: number;
  state: PullRequestState;
  url: string;
  title: string;
  headRefOid: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: string;
  checks: PrCheck[];
  feedback: Feedback[];
  localConflicts: string[];
  fetchedAt: number;
}
export interface Issue { key: string; summary: string }
export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");

export async function ghJson(args: string[], cwd: string, allowCheckExit = false): Promise<any> {
  const out = await $`gh ${args}`.cwd(cwd).nothrow().quiet();
  if (out.exitCode !== 0 && !(allowCheckExit && [1, 8].includes(out.exitCode) && out.stdout.toString().trim().startsWith("["))) {
    const message = out.stderr.toString().trim();
    if (allowCheckExit && out.exitCode === 1 && /^no checks reported on /.test(message)) return [];
    throw new Error(message || `gh exited ${out.exitCode}`);
  }
  try { return JSON.parse(out.stdout.toString()); }
  catch { throw new Error("GitHub returned invalid JSON"); }
}

export async function branchInfo(cwd: string): Promise<{ root: string; branch: string } | null> {
  const root = await $`git -C ${cwd} rev-parse --show-toplevel`.nothrow().quiet();
  if (root.exitCode !== 0) return null;
  const branch = await $`git -C ${cwd} symbolic-ref --quiet --short HEAD`.nothrow().quiet();
  if (branch.exitCode !== 0) return null;
  return { root: root.stdout.toString().trim(), branch: branch.stdout.toString().trim() };
}

async function prIdentity(cwd: string, branch: string): Promise<any | null> {
  try {
    return await ghJson(["pr", "view", branch, "--json", "number,state,url,title,headRefOid,mergeable,reviewDecision"], cwd);
  } catch (error) {
    if (error instanceof Error && /^no pull requests found for branch /.test(error.message)) return null;
    throw error;
  }
}

const THREAD_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$endCursor:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){
    pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line
      comments(first:100){pageInfo{hasNextPage endCursor} nodes{id author{login} body url updatedAt}}
    }
  }}}
}`;
const COMMENTS_QUERY = `query($id:ID!,$endCursor:String){node(id:$id){... on PullRequestReviewThread{
  comments(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{id author{login} body url updatedAt}}
}}}`;

function graphqlErrors(page: any): void {
  if (page.errors?.length) throw new Error(`GitHub GraphQL: ${page.errors.map((e: any) => e.message).join("; ")}`);
}
async function reviewFeedback(cwd: string, url: string): Promise<Feedback[]> {
  const match = new URL(url).pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
  if (!match) throw new Error("Invalid PR URL");
  const [, owner, repo, number] = match;
  const host = new URL(url).hostname;
  const pages = await ghJson(["api", "--hostname", host, "graphql", "--paginate", "--slurp", "-f", `query=${THREAD_QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${number}`], cwd);
  const feedback: Feedback[] = [];
  for (const page of pages) {
    graphqlErrors(page);
    const threads = page.data?.repository?.pullRequest?.reviewThreads;
    if (!threads || !Array.isArray(threads.nodes)) throw new Error("Missing review threads");
    for (const thread of threads.nodes) {
      if (thread.isResolved || thread.isOutdated) continue;
      const comments = [...thread.comments.nodes];
      if (thread.comments.pageInfo.hasNextPage) {
        const extra = await ghJson(["api", "--hostname", host, "graphql", "--paginate", "--slurp", "-f", `query=${COMMENTS_QUERY}`, "-f", `id=${thread.id}`, "-f", `endCursor=${thread.comments.pageInfo.endCursor}`], cwd);
        for (const p of extra) {
          graphqlErrors(p);
          if (!Array.isArray(p.data?.node?.comments?.nodes)) throw new Error("Missing thread comments");
          comments.push(...p.data.node.comments.nodes);
        }
      }
      for (const c of comments) feedback.push({ id: `${thread.id}:${c.id}`, kind: "thread", author: c.author?.login ?? "deleted", body: c.body, url: c.url, updatedAt: c.updatedAt, path: thread.path, line: thread.line });
    }
  }
  const reviewPages = await ghJson(["api", "--hostname", host, `repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`, "--paginate", "--slurp"], cwd);
  const latest = new Map<string, any>();
  for (const reviews of reviewPages) {
    if (!Array.isArray(reviews)) throw new Error("Missing reviews");
    for (const review of reviews) {
      if (review.state === "PENDING") continue;
      const author = review.user?.login ?? "deleted";
      // COMMENTED does not dismiss an earlier request for changes.
      if (review.state !== "COMMENTED" || !latest.has(author)) latest.set(author, review);
    }
  }
  for (const [author, r] of latest) if (r.state === "CHANGES_REQUESTED") feedback.push({ id: String(r.id), kind: "changes_requested", author, body: r.body || "Changes requested", url: r.html_url, path: "", line: null, updatedAt: r.submitted_at });
  return feedback;
}

export async function fetchSnapshot(root: string, branch: string): Promise<Snapshot | null> {
  const pr = await prIdentity(root, branch);
  if (!pr) return null;
  if (!Number.isSafeInteger(pr.number) || !["OPEN", "CLOSED", "MERGED"].includes(pr.state) || typeof pr.headRefOid !== "string" || typeof pr.url !== "string") throw new Error("Invalid PR identity");
  const local = await $`git -C ${root} diff --name-only --diff-filter=U -z`.nothrow().quiet();
  if (local.exitCode !== 0) throw new Error("Unable to read local conflicts");
  const [checks, feedback] = pr.state === "OPEN" ? await Promise.all([
    ghJson(["pr", "checks", String(pr.number), "--json", "bucket,name,link,state,workflow,startedAt,completedAt"], root, true),
    reviewFeedback(root, pr.url),
  ]) : [[], []];
  if (!Array.isArray(checks) || checks.some((c) => typeof c.name !== "string" || !["pass", "fail", "pending", "skipping", "cancel"].includes(c.bucket))) throw new Error("Invalid checks response");
  if (pr.state === "OPEN") {
    const head = await ghJson(["pr", "view", String(pr.number), "--json", "headRefOid,state"], root);
    if (head.headRefOid !== pr.headRefOid || head.state !== pr.state) throw new Error("PR changed during refresh; refresh again");
  }
  return { ...pr, mergeable: ["MERGEABLE", "CONFLICTING"].includes(pr.mergeable) ? pr.mergeable : "UNKNOWN", root, branch, checks, feedback, localConflicts: local.stdout.toString().split("\0").filter(Boolean), fetchedAt: Date.now() };
}

export function issuesFor(s: Snapshot, c: Config): Issue[] {
  if (s.state !== "OPEN") return [];
  const result: Issue[] = [];
  if (c.triggers.pr_conflict && s.mergeable === "CONFLICTING") result.push({ key: `merge:${s.headRefOid}`, summary: "PR conflicts with its base branch" });
  if (c.triggers.local_conflict && s.localConflicts.length) result.push({ key: `local:${digest(s.localConflicts.slice().sort())}`, summary: `Local conflicts: ${s.localConflicts.join(", ")}` });
  if (c.triggers.checks_failed) for (const check of s.checks) {
    if (check.bucket !== "fail" || (c.check_names.length && !c.check_names.includes(check.name))) continue;
    result.push({ key: `check:${digest([s.headRefOid, check.name, check.link, check.startedAt, check.completedAt])}`, summary: `Failed check: ${check.name} ${check.link}` });
  }
  if (c.triggers.review_feedback) for (const f of s.feedback) {
    if (c.review_authors.length && !c.review_authors.includes(f.author)) continue;
    result.push({ key: `review:${digest([f.id, f.updatedAt, f.body])}`, summary: `${f.kind} by ${f.author}: ${f.url}` });
  }
  return result.sort((a, b) => a.key.localeCompare(b.key));
}

export function snapshotLabel(s: Snapshot): string {
  if (s.state !== "OPEN") return `#${s.number} ${s.state === "MERGED" ? "◆" : "⊘"}`;
  const count = (bucket: string) => s.checks.filter((c) => c.bucket === bucket).length;
  const parts = [`#${s.number}`, s.mergeable === "CONFLICTING" ? "conflict" : s.mergeable === "UNKNOWN" ? "merge?" : "", s.localConflicts.length ? `local conflict ${s.localConflicts.length}` : "", count("fail") ? `CI ✗${count("fail")}` : "", count("pending") ? `●${count("pending")}` : "", count("cancel") ? `cancelled ${count("cancel")}` : "", s.checks.length && !count("fail") && !count("pending") && !count("cancel") ? "CI ✓" : "", s.feedback.length ? `Review ${new Set(s.feedback.filter(f => f.kind === "thread").map(f => f.id.split(":")[0])).size}/${s.feedback.filter(f => f.kind === "changes_requested").length}` : ""];
  return parts.filter(Boolean).join(" · ");
}

export function promptValues(s: Snapshot, issues: Issue[]): Record<string, string> {
  return { pr_url: s.url, branch: s.branch, issues: issues.map(i => `- ${i.summary}`).join("\n") || "None", checks: s.checks.map(c => `${c.name}: ${c.bucket} (${c.state}) ${c.link}`).join("\n") || "None", review_feedback: s.feedback.map(f => `[${f.kind}] ${f.author} ${f.path}${f.line ? `:${f.line}` : ""}\n${f.body}\n${f.url}`).join("\n\n") || "None", conflicts: `PR: ${s.mergeable}\nLocal: ${s.localConflicts.join(", ") || "None"}` };
}

export function detailText(s: Snapshot): string {
  const values = promptValues(s, []);
  return `${snapshotLabel(s)}\n${s.title}\n${s.url}\nBranch: ${s.branch}\nHead: ${s.headRefOid}\nUpdated: ${new Date(s.fetchedAt).toISOString()}\nReview decision: ${s.reviewDecision || "None"}\n\nConflicts\n${values.conflicts}\n\nChecks\n${values.checks}\n\nPending review feedback (threads / change requests)\n${values.review_feedback}`;
}
