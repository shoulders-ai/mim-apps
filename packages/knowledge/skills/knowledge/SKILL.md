---
name: knowledge
description: Use workspace knowledge when the user asks about durable context, people, organizations, projects, decisions, strategy, prior work, saved facts, or asks Mim to remember something.
tools: [knowledge.catalog, knowledge.get, knowledge.search, knowledge.neighbors, knowledge.graph, knowledge.create, knowledge.update]
unlocks: [knowledge.catalog, knowledge.get, knowledge.search, knowledge.neighbors, knowledge.graph, knowledge.create, knowledge.update, knowledge.delete]
---

# Knowledge

Knowledge is the durable workspace memory. Entries live as Markdown files in `knowledge/` and may also form a graph through frontmatter links. Markdown is the source of truth; `.mim/knowledge.sqlite` is only a rebuildable search/index cache.

Use Knowledge when the user asks for workspace-specific context, saved facts, prior decisions, people, organizations, client/project background, strategy notes, reusable writing/style guidance, or asks to remember/update/delete a fact.

## MCP Agents

When using Mim through MCP, dotted tool names appear with underscores:

```text
knowledge_catalog
knowledge_search
knowledge_get
knowledge_neighbors
knowledge_graph
knowledge_create
knowledge_update
knowledge_delete
```

Use these tools through MCP exactly like the dotted names below. Do not query SQLite directly and do not generate SQL. The SQLite database is an internal cache behind `knowledge_search` and can be rebuilt from Markdown at any time.

## Retrieval Workflow

1. Start with `knowledge.catalog` for broad lookup. It returns id, type, title, optional summary, and tags without bodies.
2. Use `knowledge.search` when the user gives specific terms or when catalog summaries are not enough.
3. Use `knowledge.get` only for entries that look relevant. Do not read every entry by default.
4. Use `knowledge.neighbors` after a relevant entry to traverse linked people, organizations, projects, and notes.
5. Use `knowledge.graph` when the user asks about relationships, network structure, or wants a graph-wide view.

## Entry Schema

Frontmatter fields:

| Field | Notes |
|---|---|
| `title` | Required, human-readable. |
| `type` | `person`, `org`, `project`, `note`, or `record`; defaults to `note`. |
| `summary` | Optional. Use a concise retrieval hint when helpful; omit it when the title/body is already self-explanatory. |
| `tags` | Freeform topic labels. |
| `links` | Directed edges as `"relation target-id"`. |
| `extra` | Type-specific fields exposed through tools, serialized as top-level frontmatter keys. |

Common relations:

```text
works_at          person -> org
contact_for       person -> project
has_contact       project -> person
introduced_by     project -> person
engagement_for    project -> org
references        note -> any
counterweights    note -> note
applies_to        note/project -> project/note
```

## Writing Rules

- Prefer slug IDs derived from titles, e.g. `fde-three-views`, `nicole-ferko`, `eversana-engagement`.
- Before creating an entry, check `knowledge.catalog` or `knowledge.search` for an existing match.
- Use `knowledge.update` rather than creating duplicates.
- Keep summaries short. A missing summary is fine; do not write verbose summaries just to fill the field.
- Preserve existing `links`, `tags`, and `extra` fields unless the user asks to change them.
- Mark records containing credentials, tax details, bank details, or private identifiers with `extra.sensitive: true`.
- Delete only when the user explicitly asks.

## Sensitive Entries

Sensitive records may appear in catalog/context as redacted markers. Do not quote or expose sensitive body content unless the user explicitly asks for that specific record and it is necessary for the task.
