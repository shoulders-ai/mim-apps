---
name: issue-work
description: Use when the user wants to plan, triage, reference, create, update, or continue work tracked in Mim issues.
tools: [issues.list, issues.get, issues.create, issues.update]
unlocks: [issues.list, issues.get, issues.create, issues.update, issues.delete]
---

# Issue Work

Issues are the durable organizing layer for work. A chat session is an execution context; an issue is the plan, task, review target, or follow-up thread that may span multiple chat sessions and app runs.

Use issues when the user asks to:

- plan or track a task across turns
- reference an existing issue
- turn a discussion into a durable task
- update any issue field (status, priority, labels, project, assignee, due date, body, waiting state, deliverables)
- continue work that may require more than one chat session or app run

## Issue Fields

| Field | Type | Values / Notes |
|-------|------|----------------|
| `title` | string | Required. Short, actionable. |
| `status` | enum | `backlog`, `plan`, `in-progress`, `review`, `done` |
| `priority` | enum | `low`, `normal`, `high`, `urgent` |
| `labels` | array | Each label: `{name, color}`. Colors: `gray`, `green`, `yellow`, `blue`, `purple`, `red`, `orange`. Replaces legacy `tags`. |
| `project` | string | Groups related issues. Free text, e.g. "Website redesign". |
| `assignee` | string | Who owns the issue. Free text name. |
| `dueDate` | string | ISO date, e.g. "2026-07-01". |
| `waitingFor` | string | What blocks progress. |
| `snoozeUntil` | string | ISO timestamp. Hide until this time. |
| `deliverables` | array | Each: `{path, label?}`. Files this issue produces. |
| `body` | string | Markdown. Objective, plan, decisions, blockers, next action. |

### Legacy compatibility

`tags` (flat string array) is still accepted on create/update and returned in responses, but `labels` is the primary field. When creating issues, prefer `labels` over `tags`. If the user mentions tags, map them to labels with `color: "gray"`.

## Workflow

1. **Check first.** Use `issues.list` or `issues.get` before creating — there may already be a matching issue.
2. **One at a time.** Use `issues.create` or `issues.update` for exactly one issue per call.
3. **Set fields deliberately.** When creating, set `status`, `priority`, and `assignee` if you know them. Use `project` to group related issues. Add `labels` for categorization. Set `dueDate` when there is a deadline.
4. **Keep bodies operational.** Objective, current plan, decisions, blockers, next action. Concise.
5. **Prefer updates over duplicates.** If a matching issue exists, update it.
6. **Delete only when asked.** Use `issues.delete` only when the user explicitly asks to remove an issue.

## Issue Body Shape

Use this structure when creating or substantially rewriting an issue body:

```markdown
## Objective

## Current Plan

## Decisions

## Blockers

## Next Action
```

## Good Practices

- When the user says "track this" or "make a task for this", create an issue with the discussion's key points as the body.
- When updating status, also update the body's Next Action section if the task has moved forward.
- Use `project` to reflect the user's organizational structure — ask if you're unsure which project an issue belongs to.
- Use descriptive label names like `bug`, `feature`, `research`, `blocked` — not abbreviations.
- Set `waitingFor` when the issue is blocked on an external dependency, and clear it when unblocked.

Do not expose internal storage details (file paths, IDs) unless the user asks. If an issue is missing or stale, say so directly and either create or update.
