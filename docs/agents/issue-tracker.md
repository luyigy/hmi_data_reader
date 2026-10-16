# Issue tracker: GitHub

Issues and specs for this repo live in `luyigy/agent-platform-v2` on GitHub. Use the `gh` CLI with `-R luyigy/agent-platform-v2` for issue and pull-request commands. For `gh api`, use explicit `repos/luyigy/agent-platform-v2/...` paths.

This config tells Matt Pocock’s skills where to manage issues. New work uses Spec packages and approved task graphs; historical PLAN/HANDOVER documents are read-only references. The retired document watcher must not dispatch new work.

## Conventions

- **Create an issue**: `gh issue create -R luyigy/agent-platform-v2 --title "..." --body "..."`. Use a body file for multi-line bodies.
- **Read an issue**: `gh issue view <number> -R luyigy/agent-platform-v2 --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list -R luyigy/agent-platform-v2 --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> -R luyigy/agent-platform-v2 --body "..."`
- **Apply / remove labels**: `gh issue edit <number> -R luyigy/agent-platform-v2 --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> -R luyigy/agent-platform-v2 --comment "..."`

Pass `-R luyigy/agent-platform-v2` on every repository command. Do not rely on `gh` inferring from this clone’s multiple remotes.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> -R luyigy/agent-platform-v2 --comments` and `gh pr diff <number> -R luyigy/agent-platform-v2` for the diff.
- **List external PRs for triage**: `gh pr list -R luyigy/agent-platform-v2 --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: pass `-R luyigy/agent-platform-v2` to `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, and `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42 -R luyigy/agent-platform-v2` and fall back to `gh issue view 42 -R luyigy/agent-platform-v2`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> -R luyigy/agent-platform-v2 --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create -R luyigy/agent-platform-v2 --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/luyigy/agent-platform-v2/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/luyigy/agent-platform-v2/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list -R luyigy/agent-platform-v2 --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> -R luyigy/agent-platform-v2 --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> -R luyigy/agent-platform-v2 --body "<answer>"`, then `gh issue close <n> -R luyigy/agent-platform-v2`, then append a context pointer (gist + link) to the map's Decisions-so-far.
