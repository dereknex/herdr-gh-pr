# herdr-plugin-gh-pr

Shows the focused agent pane's branch PR status in the herdr sidebar, including merge conflicts, local git conflicts, CI checks, and pending review feedback. An on-demand popup shows details. Optional repair prompts can be submitted to a matching agent.

## Requirements

- herdr >= 0.9.3 (client and server, for plugin popups and agent prompts)
- Bun, git, and authenticated gh on PATH
- GitHub permission to read the repository's PRs, reviews, and checks

## Install

```bash
herdr plugin install dereknex/herdr-gh-pr
```

Or link a local checkout:

```bash
herdr plugin link /path/to/herdr-plugin-gh-pr
```

No daemon or polling process is required. Auto-send is off by default.

## Sidebar

Add `$pr` to the agent rows in `~/.config/herdr/config.toml`, then run `herdr server reload-config`:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", "$pr"], ["agent"]]
```

Example: `#123 · conflict · CI ✗2 · ●1 · Review 3/1`.

- `conflict`: the PR conflicts with its base branch. `merge?`: GitHub has not determined mergeability.
- `local conflict N`: N unresolved files in the local git index, independent of PR mergeability.
- `CI ✗N`, `●N`, `cancelled N`, `CI ✓`: failed, pending, cancelled, or passing/skipped checks.
- `Review N/M`: N unresolved, non-outdated review threads and M active requests for changes. Bot feedback is included. Ordinary PR comments are excluded.
- `◆`: merged. `⊘`: closed. `⟳`: refreshing.
- `sent`: submitted, with repair results still reported by the agent. `queued`, `recipient needed`, `sent?`: deferred, ambiguous recipient, or uncertain delivery.
- `error`: refresh/config/command failure. The previous result is retained when it belongs to the same worktree and branch; its timestamp and error are visible in details. It may be stale.

Sidebar tokens are plain text: herdr styles them with color, bold, and dim, and does not render hyperlinks. To open the PR, use the `gh-pr.open-pr` action on a key binding, or click the PR URL in details, which runs in a terminal pane.

Sidebar values are capped at 80 characters. Details contain all checks with links, conflict files, feedback authors, bodies, code locations, and links.

## Refresh and actions

The existing refresh model is retained: `pane.focused`, `worktree.opened`, and `worktree.created`. Automatic refreshes are throttled to once per pane per 30 seconds. A branch change bypasses the throttle; manual refresh always bypasses it. There is no periodic refresh. Changes on GitHub and deferred prompts are reconsidered at the next event or manual refresh.

```bash
herdr plugin action invoke gh-pr.refresh
herdr plugin action invoke gh-pr.open-pr
herdr plugin action invoke gh-pr.details
herdr plugin action invoke gh-pr.send-repair
```

`details` opens a scrollable popup and fetches current data without sending a repair prompt. Use arrows, j/k, or PgUp/PgDn to scroll; q or Escape closes it. `send-repair` refreshes and explicitly submits the configured prompt, bypassing auto-send enablement, deduplication, cooldown, and the clean-worktree check. It can therefore prompt an agent while local changes are uncommitted. It still requires a ready matching agent, an open PR, and enabled trigger issues.

Actions can be bound in herdr's config:

```toml
[[keys.command]]
key = "prefix+i"
type = "plugin_action"
command = "gh-pr.refresh"
description = "refresh PR status"

[[keys.command]]
key = "prefix+p"
type = "plugin_action"
command = "gh-pr.details"
description = "view PR details"
```

Choose unused keys and run `herdr server reload-config`. Plugins cannot add context-menu items or ship keybindings.

## Configuration

Find the directory with `herdr plugin config-dir gh-pr`. Create `config.toml` there; it is re-read on the next actual refresh or action. The checked-in [config.example.toml](config.example.toml) contains the defaults.

```toml
auto_send = false
cooldown_seconds = 600
recipient = "" # Live agent name or pane ID; empty selects a unique match.
check_names = [] # Exact check names; empty includes all.
review_authors = [] # Exact GitHub logins; empty includes humans and bots.

[triggers]
pr_conflict = true
local_conflict = false
checks_failed = true
review_feedback = true

[repositories."/absolute/path/to/worktree"]
auto_send = true
recipient = "fixer"
check_names = ["test", "lint"]
```

Overrides match the absolute git worktree root, so each worktree can have its own policy. Selected values override global defaults; unspecified fields are inherited. Trigger types use OR: any enabled, matching issue qualifies. Multiple issues are combined into one prompt. Invalid keys, values, templates, or missing template files fail visibly and prevent sending.

### Custom prompt

Set either `prompt` (TOML multiline string) or `prompt_file` (absolute path or relative to the plugin config directory):

```toml
prompt_file = "repair-prompt.txt"
```

Supported variables are `{pr_url}`, `{branch}`, `{issues}`, `{checks}`, `{review_feedback}`, and `{conflicts}`. Unknown variable names fail. Feedback is inserted as data once; braces inside it are not interpreted as template variables.

The [default prompt](src/config.ts) asks the agent to verify applicability, fix current issues, run relevant validation, and report changes and unresolved issues. It treats review text as information to assess. Commit, push, merge, GitHub replies, and resolving threads require existing user authorization. A custom template controls the submitted instructions.

### Auto-send rules

- Only open PRs qualify. Current-head failed checks trigger; pending, cancelled, skipped, and unknown states do not. Local conflicts only trigger if explicitly enabled.
- Each issue version is sent once. Comment edits, new comments, changed CI runs, or an issue that disappears and later recurs can qualify again. Initial existing issues qualify when auto-send is enabled. Sending all issues together marks all current issue versions as sent.
- The default cooldown is 10 minutes per session, worktree, and PR, across panes. Persisted records and locks prevent overlapping refreshes from submitting duplicates.
- Only a unique matching agent, or a configured matching recipient, can receive prompts. Multiple matches without a recipient defer delivery. An agent must be `idle` or `done`; `working`, `blocked`, and `unknown` defer delivery until a later refresh. The plugin does not answer approval dialogs.
- Before sending, it re-fetches PR issues and rechecks agent identity, readiness, worktree, branch, and head. Local HEAD must equal the PR head, so unpushed commits prevent submission, including manual submission.
- Automatic sending also requires a clean worktree, including staged, unstaged, untracked, and submodule changes. Ignored files do not block it. A dirty worktree shows `queued` and the reason in details; after changes are committed and pushed, a later refresh re-evaluates the issues. Local index conflicts also make the worktree dirty, so the `local_conflict` trigger requires manual `send-repair`.
- A successful submission means text and Enter were delivered, not that a repair started or completed. An uncertain submission stops further automatic attempts; inspect the agent and use `send-repair` if a retry is needed.

Runtime state lives in `HERDR_PLUGIN_STATE_DIR`. Removing it resets caches, cooldown, and deduplication, so existing issues can trigger again.

## Develop

```bash
bun test
herdr plugin log list gh-pr
```

No external npm dependencies or build step. Tests include real git worktrees and fixture CLIs, without prompting live agents.
