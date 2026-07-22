# Mail — Visual Design System

Governing visual spec. Where UX-SPEC.md §1–§3 disagree with this file, this
file wins (it is the ratified outcome of the 3-direction design panel +
12-persona workshop; thesis: **dense triage instrument**, amended by
workshop findings and grafts from the other directions).

## Principles

- The primary user triages a large mailbox with the keyboard; density and
  velocity beat decoration. Reading and drafting get one comfortable metric,
  chrome stays out of the way.
- **No serif anywhere.** All text is `--font-sans`; data is `--font-mono`.
- **Radius policy 0/3/4**: panes, rows, bars 0 · controls, inputs, chips,
  strips 3px · menus, confirm card, help sheet 4px. No pills.
- **Hover contract**: every clickable gets `background: var(--color-chrome-mid)`
  on hover; arrow cursor everywhere; pointer only on `a[href]`.
- **Ink discipline**: `--color-ink-4` only for placeholders, disabled labels,
  and kbd hints whose content is duplicated in `title` attributes. Everything
  informational is ink-3 or darker.
- `overscroll-behavior: contain` on every scroll container.

## Typography ramp (complete — no other sizes)

| Role | Font | Size / weight | Color |
|---|---|---|---|
| Reading body | sans | 13.5 / 400, lh 1.55 | ink — bodies, editor, strips |
| Row sender | sans | 12.5 / 600 read · 700 unread | ink-2 · ink |
| Row subject | sans | 12.5 / 400 read · 600 unread | ink-2 · ink |
| Row snippet | sans | 12.5 / 400 | ink-3 |
| Control | sans | 12 / 650 | ink-3 idle · ink-2 hover |
| Primary button | sans | 13 / 700 | accent-ink on accent |
| Label | sans | 11 / 600 | ink-3 |
| Section micro | sans | 10 / 600 caps | ink-3 |
| Data | mono | 10.5 / 500 | ink-3 — timestamps, counts, addresses |
| Kbd hint | mono | 10 / 500 | ink-4 (duplicated in `title`) |

**Metric parity contract**: `.msg-body`, `.ed-ta`, `.hl-back`, `.ed-mirror`,
`.strip-body` share one font declaration (13.5/1.55 sans) in a single CSS
rule — hunk-overlay alignment and `paragraphRects()` depend on it.

## Chrome

- **Command bar, 36px**: `Mail` label (11/600 ink-3) · flat text tabs with
  `inset 0 -2px 0 accent` active underline · separator · Voices · right:
  rectangular search (24px, radius 3), compose / refresh / settings icon
  buttons (24×24, radius 3; open-menu state = accent-tint bg + accent icon).
- **Status bar, 22px** (chrome-high): left — sync state (silence = healthy;
  `syncing N / ~M` with 1.5px accent progress on the top edge; `synced Xm
  ago`; `sync failed · Retry`) and transient action messages replacing all
  floating toasts (`Archived · Undo (z)`), 8s + hover/focus pause when they
  carry an action; right — `12/143` position counter and per-region key
  hints (hidden < 560px).
- **Reconnect banner**: tint-rem, `role=alert` rendered once, countdown
  updated via `textContent` in an aria-hidden child.

## Inbox rows

One line, 28px, grid `12px · sender(112/168px) · subject—snippet · flags ·
time(44px)`. No per-row hairlines. Unread = 5px accent dot + 700 sender +
600 subject. Selected = accent-tint + `inset 2px 0 0 accent`. Hover reveals
a 20×20 archive icon-button (`Archive (e)`). The subject renders at every
pane width — there is no subject-dropping compact variant.

## Thread view

36px head (13/700 subject, icon-only actions) · 640px column · 26px
collapsed rows (sender · snippet · mono date right) · one-line open header
(sender 12.5/700 + address 11 ink-3 + date right; recipients line only when
not a 1:1) · body 13.5/1.55 with a 20px left gutter, bare URLs linkified
(safe anchors, the app's only pointer cursor) · quote fold as mono
`› quoted (n lines)` · messages separated by a single line-soft rule.

## Studio

Sticky head 28px chrome-high · editor blocks gap 16px · hunk tints keep the
§6.2 formulas plus an inset hairline on hot marks
(`color-mix(in srgb, var(--color-add|rem) 45%, transparent)`) · strips
radius 3 with 2px add/rem spine · confirm card radius 4, chrome-high, 2px
accent inset rail, **From row first**, selectable values, invalid
recipients marked and Send disabled · primary buttons 24px, 13/700.

## Keyboard additions

`z` undo (while a status message shows) · `?` help sheet · `g` Open in
Gmail (thread scope). Full map in the `?` overlay and status-bar hints.
