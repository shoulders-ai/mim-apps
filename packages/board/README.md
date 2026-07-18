# Board

Kanban issue board for tracking work in your workspace.

Issues live in the workspace `issues/` folder as plain markdown files with YAML frontmatter, so they travel with the project and are visible to every tool.

## Views

- **Board** — columns grouped by status or project, drag-drop between columns
- **List** — grouped rows with inline field controls, sortable and filterable

Click an issue to open the full detail view with editable title, description, and a properties sidebar. The content column and sidebar scroll independently. The description renders as markdown; click it to edit, click away (or press Escape) to save and return to the rendered view.

Label and project menus filter as you type; Enter toggles the best match, and a Create row adds a new entry when nothing matches. New labels get an automatic color; recolor any label from the "..." control on its row.

## Issue Fields

`title`, `status` (backlog/plan/in-progress/review/done), `priority` (low/normal/high/urgent), `labels` (name + color), `project`, `assignee`, `dueDate`, `waitingFor`, `snoozeUntil`, `deliverables`, `body`.

## Tools

`issues.list`, `issues.get`, `issues.create`, `issues.update`, `issues.delete`

For `issues.create` and `issues.update`, pass `labels` as a native array.
JSON-encoded strings are rejected by the tool schema.
