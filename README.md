# Mim Apps

Reference apps for [Mim](https://github.com/shoulders-ai/mim-os), the operating
system for AI-native research organisations.

This repository is the app authoring and runtime-compatibility catalog. It is
not a Team source and Mim does not browse or install apps from a remote
registry. Apps become available from one of Mim's three owned locations:

```text
Mim build resources/apps/<id>/
Team source/apps/<id>/
Project/packages/<id>/
```

Project overrides Team and Team overrides Mim when the same id exists more than
once. Availability does not enable an app: every person reviews and enables
apps locally for each Project.

The private operational Team source is
[shoulders-ai/mim-team](https://github.com/shoulders-ai/mim-team). Reusable app
changes are authored and tested here, then promoted into that Team's `apps/`
directory.

## Apps

| App | Description |
| :-- | :-- |
| **Board** | Kanban board for tracking issues and tasks. Plain-file storage, AI-accessible. |
| **DOCX Review** | Multi-agent academic peer review — writes comments back into a `.docx` revision copy. |
| **GitHub Monitor** | Org-wide GitHub activity: issues, PRs, project boards, saved views, AI summaries. |
| **Import to Markdown** | Converts Word, Excel, BibTeX, and PDF files into AI-ready Markdown. |
| **Knowledge** | Workspace knowledge base for persistent notes, decisions, and context. |
| **Mail** | AI-native Gmail: local mirror, proposal-state AI drafting, legible voices, hard human send gate, provenance flywheel. |
| **References** | Reference library with DOI, PDF, and paste capture. Grounded citation tools for the editor. |
| **Scholar** | Reproducible literature search across PubMed, Europe PMC, arXiv, ClinicalTrials.gov, and more. |
| **Slides** | Slide decks as paginated HTML with print-exact PDF export. |
| **Word Count** | Headless example app for counting words, characters, and lines. |
| **Word Count 2** | Second headless example for testing independent app identities. |

Each app has its own README under `packages/<id>/`.

## Development

Clone this repository and open it as a Mim Project. Mim discovers each
`packages/<id>/` directory as a Project app:

```text
packages/<id>/
  package.json        # Mim manifest
  backend/            # optional backend entry and modules
  ui/                 # optional views
  skills/             # optional app-bundled skills
  README.md            # app documentation shown in Mim
```

Use **Settings > Apps & agents** to review and enable an app in this checkout.
After editing, validate and reload the app catalog.

## Promotion

Push reusable source changes to `main`. CI runs the app suite first,
patch-bumps changed packages when needed, and regenerates `index.json` as
catalog and compatibility metadata. It is not an installation registry.

To release an app through a Team source:

1. make and test the change here;
2. copy the intended `packages/<id>/` directory to the Team's `apps/<id>/`;
3. review the Team repository diff;
4. commit and push the Team promotion.

Do not copy Project data folders such as `issues/` or `knowledge/`. App source
and Project data are separate.

## Tests

```bash
npm install
npm test
```

Tests live next to source files (`packages/**/*.test.{mjs,ts}`). To verify this
catalog against the current Mim runtime, run `npm run test:packages:compat` in
the [Mim core repository](https://github.com/shoulders-ai/mim-os).
