# Knowledge

Workspace knowledge base for capturing and retrieving persistent notes, decisions, people, organizations, projects, and records.

Add entries through the UI or chat. The AI can query the knowledge base to ground its answers in workspace-specific facts. Entries are stored in the `knowledge/` folder as plain files.

Entries are Markdown files with YAML frontmatter:

```yaml
---
title: "FDE Three Views"
type: note
summary: "Optional short retrieval summary."
tags: [fde, framework]
links:
  - "references fde-pitch-notes"
created: "2026-06-24T00:00:00.000Z"
updated: "2026-06-24T00:00:00.000Z"
---
Body content.
```

`type` defaults to `note`. `summary` is optional; keep it short when present. `links` are directed graph edges in `"relation target-id"` form.

Tool calls should send `tags` and `links` as arrays; `knowledge.create` and `knowledge.update` also normalize JSON-stringified or comma-separated list strings from AI tool callers.

The app also maintains a disposable derived SQLite index at `.mim/knowledge.sqlite` for search and graph queries. Markdown remains the source of truth.

## Views

Four projections over the same entries, sharing the search/tag/type filters:

- **List** — card grid, newest first.
- **Board** — kanban columns grouped by the `status` frontmatter field (any string; entries without a status are hidden here). Common lifecycle statuses (`backlog`, `todo`, `pipeline-cold`, `pipeline-warm`, `contracting`, `active`, `in-progress`, `waiting`, `review`, `paused`, `done`, `archived`) sort first in that order; unknown statuses follow alphabetically. Drag a column header to reorder — the order is stored per workspace in app data, not in your files.
- **Timeline** — recency audit: one bar per entry showing days since last update (0–90d+), longest-untouched first. Useful for spotting dormant threads; note it tracks file updates, not real-world contact.
- **Graph** — force-directed view of the link structure.

The app ships the `package:knowledge/knowledge` skill so chat agents use catalog-first retrieval, read bodies only after narrowing candidates, traverse links with `knowledge.neighbors`, and handle sensitive records conservatively.

**Tools:** `knowledge.list`, `knowledge.catalog`, `knowledge.get`, `knowledge.create`, `knowledge.update`, `knowledge.neighbors`, `knowledge.graph`, `knowledge.search`, `knowledge.delete`
