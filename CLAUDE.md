# herdr-plugin-gh-pr

Bun + TypeScript, zero external npm dependencies. herdr >= 0.9.3.

## Runtime contracts

- `pr` is a pane metadata token under source `gh-pr`; users include `$pr` in sidebar agent rows. Values have an 80-character limit. Do not use legacy `custom_status`.
- Refresh remains event-driven: pane focus and worktree open/create, per-pane 30-second throttle, manual force bypass. Branch changes bypass the throttle. There is no polling daemon.
- PR snapshots include GitHub mergeability, local index conflicts, all current-head checks, unresolved non-outdated threads, and active requests for changes. Queries paginate threads, thread comments, and reviews. Errors retain a same-branch snapshot with a visible stale/error indicator.
- Config belongs under `HERDR_PLUGIN_CONFIG_DIR`; state under `HERDR_PLUGIN_STATE_DIR`. Auto-send defaults off. Validate config before sending; state IO errors must prevent submission.
- Prompt submission uses `herdr agent prompt`, a unique matching or configured recipient, and `idle`/`done` only. Revalidate issues, agent identity, root, branch, and head. Local HEAD must equal PR head. Persist the attempt before IO; uncertain delivery blocks automatic retries.
- Locks serialize pane refresh and PR submission. Deduplication and cooldown are shared across panes for the session/worktree/PR. Manual send bypasses those policies, but still validates readiness and issue eligibility.
- Details use a plugin-owned terminal popup. Its action passes the target pane explicitly because a popup has no pane ID. Details fetch without sending; sanitize external text before terminal rendering.
- Manifest commands invoke Bun explicitly. Actions use workspace context and resolve the focused pane. No external dependencies means no install build step.

Read README.md for configuration, prompt variables, trigger semantics, and actions. The 0.7.4 capability research in docs/research/herdr-plugin-overlay.md is historical; installed CLI/schema and current official docs are authoritative for newer APIs.

## Development

`bun test` includes pure logic and end-to-end CLI fixtures with real git worktrees. Keep tests isolated from live herdr agents. Log inspection: `herdr plugin log list gh-pr`.

## Conventions

- No em dashes in code, comments, or docs.
- Metadata source is always `gh-pr`.
