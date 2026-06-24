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

The app also maintains a disposable derived SQLite index at `.mim/knowledge.sqlite` for search and graph queries. Markdown remains the source of truth.

The app ships the `package:knowledge/knowledge` skill so chat agents use catalog-first retrieval, read bodies only after narrowing candidates, traverse links with `knowledge.neighbors`, and handle sensitive records conservatively.

**Tools:** `knowledge.list`, `knowledge.catalog`, `knowledge.get`, `knowledge.create`, `knowledge.update`, `knowledge.neighbors`, `knowledge.graph`, `knowledge.search`, `knowledge.delete`
