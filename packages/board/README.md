# Board

Kanban issue board for tracking work in your workspace.

Issues live in the workspace `issues/` folder as plain markdown files with YAML frontmatter, so they travel with the project and are visible to every tool.

## Views

- **Board** — columns grouped by status or project, drag-drop between columns
- **List** — grouped rows with inline field controls, sortable and filterable

Click an issue to open the full detail view with editable title, description, and a properties sidebar.

## Issue Fields

`title`, `status` (backlog/plan/in-progress/review/done), `priority` (low/normal/high/urgent), `labels` (name + color), `project`, `assignee`, `dueDate`, `waitingFor`, `snoozeUntil`, `deliverables`, `body`.

## Tools

`issues.list`, `issues.get`, `issues.create`, `issues.update`, `issues.delete`
