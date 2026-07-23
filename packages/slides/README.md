# Slides

Mim app for drafting slide decks as paginated HTML and exporting print-exact
PDF.

This directory is a Project app while developing in `mim-apps`. To share it
across Projects, promote the whole directory to a Team source at
`apps/slides/`. A Project can instead own a copy at `packages/slides/`.

After adding or editing the app, reload the app catalog, review its permissions,
and enable it for the current Project. The copy must include `shared/`, which
contains chart and model utilities used by the backend. Slides depends on the
core `render.htmlToPdf` tool provided by Mim.

## Usage

**Generate** a deck from a brief — include style, tone, and length wishes in the brief text. Attach workspace files (sources, templates, examples, assets) through the built-in file picker. The backend gives the model a fixed PowerPoint-geometry HTML template, writes the returned deck to normal workspace files, and renders PDF once. It does not run an automatic repair loop or vision critique.

**Refine** an existing deck. After generation, use the refine bar in the result view to apply one instruction to the current `deck.html`; the backend writes the updated HTML and renders PDF once. Further iteration can happen through the editor, chat agent file edits, or another refine run.

Generated decks are ordinary workspace files:

```text
slides/<slug>-<run>/
  brief.md
  deck.html
  deck.pdf
  deck-plan.json
```

Use a Project copy when Slides should evolve with one customer workflow. Use a
Team copy when the same app version should be available across Projects.
Availability and activation remain separate in both cases.
