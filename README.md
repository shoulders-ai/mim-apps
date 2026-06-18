# Mim Apps

Apps for [Mim](https://github.com/shoulders-ai/mim-os) — the operating system for AI-native research organisations.

Browse and install from **Settings > Apps** inside Mim.

## Apps

| App | Description |
| :-- | :-- |
| **Board** | Kanban board for tracking issues and tasks. Plain-file storage, AI-accessible. |
| **DOCX Review** | Multi-agent academic peer review — writes comments back into a `.docx` revision copy. |
| **GitHub Monitor** | Org-wide GitHub activity: issues, PRs, project boards, saved views, AI summaries. |
| **Import to Markdown** | Converts Word, Excel, BibTeX, and PDF files into AI-ready Markdown. |
| **Knowledge** | Workspace knowledge base for persistent notes, decisions, and context. |
| **References** | Reference library with DOI, PDF, and paste capture. Grounded citation tools for the editor. |
| **Scholar** | Reproducible literature search across PubMed, Europe PMC, arXiv, ClinicalTrials.gov, and more. |
| **Slides** | Slide decks as paginated HTML with print-exact PDF export. |

Each app has its own README under `packages/<id>/` with full documentation.

## Development

Clone this repo and open it as your Mim workspace. Mim loads every `packages/<id>/` directory live — edits appear on reload.

```
packages/<id>/
  package.json        # mim manifest (id, views, backend, permissions, engines)
  backend/            # backend entry (index.mjs) and modules
  ui/                 # views referenced by the manifest
```

### Publishing

Bump `version` in `packages/<id>/package.json` and push to `main`. CI regenerates `index.json` from every package manifest and the current commit. Users see updates in Settings > Apps on next refresh.

Packages hosted in other repos can be added to `external.json`. The registry build merges them into `index.json` alongside local packages.

### Tests

```bash
npm install && npx vitest run
```

Tests live next to source files (`packages/**/*.test.{mjs,ts}`). For runtime compatibility testing against the Mim core, see the [core repo](https://github.com/shoulders-ai/mim-os).
