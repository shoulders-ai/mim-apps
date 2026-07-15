# Mail — UX Specification (binding)

Author: UX owner (Fable). Wave 3 implements exactly this; the same owner
audits the built UI against §8 afterwards. Where this file and
[CONTRACTS.md](CONTRACTS.md) disagree on data/tool shapes, CONTRACTS wins;
where this file and [plan.md](plan.md) §9 disagree on UX, this file wins
(it refines §9, it does not contradict it).

Non-negotiables inherited from mim-os `docs/design-system.md`:
`tokens.css` variables only; no `cursor: pointer` anywhere (arrow cursor,
hover-background is the affordance); no hover transitions; no shadows except
floating popovers/menus; `:focus-visible` rings only; every control has a
`title` tooltip including its shortcut; UI chrome is `user-select: none`,
content opts back in. All copy is terse — no instruction sentences in chrome.

---

## 1. Foundations

### 1.1 Palette

The app receives exactly the variables in `mim-os/sdk/tokens.css`, themed by
the host (initial values via `#mim-theme=` URL fragment, live changes via
postMessage — copy Board's `index.html` bootstrap verbatim and add the
postMessage listener). There is **no other palette**. `--color-rem` collides
with `--color-accent` in the default theme, therefore **removal semantics are
never carried by text color** — background tints only, via `color-mix` (§6.2).

### 1.2 Type scale (complete — no other sizes may be introduced)

| Role | Font | Size/weight | Line | Usage |
|---|---|---|---|---|
| Surface title | `--font-sans` | 14px / 700 | 1.2 | "Mail" header, thread subject in thread view |
| Row primary | `--font-sans` | 12.5px / 650 unread · 600 read | 1.35 | List sender, voice names, dialog labels |
| Row secondary | `--font-sans` | 12px / 400 | 1.35 | Subject+snippet line, message preview |
| Control | `--font-sans` | 12px / 600 | 1 | Buttons, tab pills, menu rows |
| Meta | `--font-sans` | 11px / 600 | 1 | Section labels, chips, banner text |
| Content | `--font-serif` | 14px / 400 | 1.65 | Message bodies, **the editor**, voice docs |
| Data | `--font-mono` | 10.5px / 500 | 1 | Timestamps, counts, sync progress, funnel numbers |
| Micro label | `--font-sans` | 10px / 600 uppercase, ls 0.04em | 1 | "PROPOSED CHANGES", learning panel headings |

Root/body: 13px sans (Board precedent). Minimum size for any informational
text: 10px. `--font-brand` appears once: the onboarding headline (18px).

### 1.3 Spacing, radius, hairlines

- Spacing: 4 / 8 / 12 / 16 / 24 (`--space-xs/sm/12/md/lg`; 12 is a literal).
- Radius: controls & chips 4–5px, cards/strips 6px (`--radius-md`), dialogs
  8px (`--radius-lg`). Nothing else rounds. Panes never round.
- Dividers: `--color-rule-light` 1px everywhere; `--color-rule` only for the
  floating card/menu borders and the confirm card.

### 1.4 Ink discipline (contrast contract)

Host floors (all 8 themes, enforced in mim-os): ink ≥8:1, ink-2 ≥5.5:1,
ink-3 ≥4.5:1, ink-4 ≥3:1 on all chrome+surface. Derived binding rules:

1. Informational text uses **ink / ink-2 / ink-3 only**. `--color-ink-4` is
   restricted to placeholder text, disabled labels, and kbd hints whose
   information exists elsewhere — never sole carriers of meaning.
2. On **tinted backgrounds** (§6.2) only `ink` (content) and `ink-2` (meta)
   are permitted. Never ink-3/ink-4 on a tint.
3. `text` in `--color-accent` only on interactive elements ≥12px/600.
4. Text on `--color-accent` fills uses `--color-accent-ink`, at 13px/700
   minimum (see §6.4 note on this host-owned pair).

---

## 2. Layout system

The app owns a single Work view. Work pane range: 336px floor, typically
700–1100px. One breakpoint, measured on the app root via `ResizeObserver`
(not media queries — the iframe is pane-sized, not viewport-sized):

- **WIDE ≥ 880px** — split: thread list pane left, thread/reading pane right.
- **NARROW < 880px** — single column: list OR thread, thread replaces list
  with a back control (Board `header-back` pattern). Everything must remain
  fully functional at 336px; the studio must be comfortable at 700px with
  zero horizontal scroll.

### 2.1 Zones

```
┌────────────────────────────────────────────────────────────────┐
│ HEADER (40px, surface, border-b rule-light)                    │
│ TAB ROW (36px: tabs + search + sync state, border-b rule-light)│
├───────────────┬────────────────────────────────────────────────┤
│ LIST PANE     │ THREAD PANE                                    │
│ clamp(296px,  │ flex-1, min 0                                  │
│ 36%, 384px)   │ content column max 680px, centered,            │
│ border-r      │ padding 16px 20px                              │
│ rule-light    │ (messages → docked studio, one scroll context) │
└───────────────┴────────────────────────────────────────────────┘
```

- Voices & Learning replaces the whole area below HEADER (its own tab row).
- Onboarding replaces everything below HEADER.
- The reconnect banner (§5.6) slots between HEADER and TAB ROW, full width.
- Backgrounds: everything is `--color-surface`; the only `--color-chrome-high`
  areas are the studio's sticky proposal header and the learning side panel.
  `--color-chrome-mid` is hover/demotion only. `--color-chrome` is unused
  (reserved for host shell).

### 2.2 Density rules

- List rows: 44px fixed, two text lines. In the NARROW single-column layout
  below 400px app width the snippet drops (row 32px, single line); the WIDE
  split list keeps two-line rows at its 296–384px clamp.
- Collapsed message rows in a thread: 32px.
- Controls: 26×26px icon buttons, 26px pills, 24px inputs in toolbars.
- Learning panel (WIDE): fixed 240px right column inside Voices. NARROW:
  stacks below the voice doc.
- Editor and message bodies: measure capped at 680px — never full-bleed at
  1100px.

---

## 3. Surfaces

### 3.1 Onboarding (route when `connect_status.connected === false`)

Guided BYO-OAuth-client setup. Numbered steps; the current step is expanded,
completed steps collapse to a ✓ line, future steps are dimmed (ink-3).
Vertically centered column, max 520px. `--font-brand` headline.

```
┌────────────────────────────────────────────────────────────┐
│                        Mail                                │
│      Your Gmail, drafted with you — stored in one          │
│      local file. Nothing touches a third-party server.     │
│      One-time setup, about 5 minutes.                      │
│                                                            │
│  ✓ 1 Create a Google Cloud project            (collapsed)  │
│  ✓ 2 Enable the Gmail API                     (collapsed)  │
│  ● 3 Configure the consent screen                          │
│      Open consent screen ↗                                 │
│      Workspace account → choose Internal.                  │
│      ┌ ⚠ Personal account → External + Testing:          ┐ │
│      │ Google expires the connection every 7 days —      │ │
│      │ you'll reconnect weekly. Add yourself as a        │ │
│      │ test user.                                        │ │
│      └───────────────────────────────────────────────────┘ │
│      [ Done — next ]                                       │
│  ○ 4 Create a Desktop-app OAuth client                     │
│  ○ 5 Paste the client JSON                                 │
└────────────────────────────────────────────────────────────┘
```

- Step links are real `<a target="_blank">` (pointer cursor allowed here,
  the only place): `console.cloud.google.com/projectcreate`,
  `/apis/library/gmail.googleapis.com`, `/apis/credentials/consent`,
  `/apis/credentials/oauthclient`.
- The Testing-mode warning card: bg `color-mix(in srgb, var(--color-rem) 10%,
  var(--color-surface))`, border `rule-light`, text ink-2, icon ⚠ ink-2.
  It is informational framing, not an error.
- **Step 5 — paste + instant validation.** A monospace `<textarea>`
  (placeholder `Paste client_secret_*.json`). Validation runs on every input
  event, client-side, pure function (`validateClientJson`, tested):
  - invalid JSON → `Not valid JSON yet.` (quiet, ink-3 — while typing this
    is expected, not an error)
  - has `web` key → `This is a Web application client. Create a Desktop app
    client instead.` (error style)
  - missing `installed.client_id` / `installed.client_secret` → named field
    error.
  - valid → green-tinted confirmation row (`add` tint 12%, ink text):
    `Desktop client ✓ · project {project_id}` and the primary button
    **Connect Google** enables.
- Connect Google → store secret, then `connect_start`:
  1. Button state `Connecting…` (spinner, disabled).
  2. `{consent_url}` → `window.open(url)`. If `window.open` returns null:
     inline row `Browser didn't open — Copy link` (copies URL, toast
     `Link copied`).
  3. Waiting state: `Waiting for Google… (2:00)` with a live countdown
     (120s backend timeout). Cancel link → `connect_disconnect`-free abort
     (just reset UI; backend flow self-terminates).
  4. `{error}` → inline error card under the button, verbatim reason +
     `Try again`.
- On success: route → Inbox immediately (**streaming**, §3.2). Never a
  blocking "syncing" screen.

### 3.2 Inbox

```
┌────────────────────────────────────────────────────────────────┐
│ Mail                    [🔍 Search mail____]  ✎ Compose  ⟳  ⚙ │
│ Inbox · All · Sent · Drafts        Voices      1,240 / ~4,800 ▁│
├────────────────────────────────────────────────────────────────┤
│ ● Anna Schmidt                                     ⌗2    14:32 │
│   Re: Q3 budget — Here's the updated breakdown for…            │
│ ─────────────────────────────────────────────────────────────  │
│   DB Regio Nordost                                       09:10 │
│   Störungsmeldung RB24 — Ersatzverkehr zwischen…          📎   │
│ ─────────────────────────────────────────────────────────────  │
│   …                                                            │
│                    [ load-more sentinel ]                      │
└────────────────────────────────────────────────────────────────┘
```

- **Header row (40px):** title left; right cluster: search box (Board
  `search-box`, flexes, collapses to icon <560px), `✎ Compose` (icon-only
  <560px), `⟳` manual refresh, `⚙` settings popover.
- **Tab row (36px):** pills `Inbox · All · Sent · Drafts` (Board `tab-pill`)
  left; right: `Voices` pill (with a 5px accent dot when pending flywheel
  proposals or a fresh seed exist) and the sync state cell.
- **Sync state cell** (mono 10.5px, ink-3):
  - backfill running: `1,240 / ~4,800` + a 1.5px `--color-accent` progress
    line pinned to the tab row's bottom border (width = done/total). The
    accent line is signal, not fill — nothing else in the row is tinted.
  - idle: last sync relative time `synced 12s ago` — shown only when >75s
    (otherwise empty; silence = healthy).
  - sync job error (non-auth): `sync failed · Retry` (Retry = `jobs_kick`).
  - auth error: nothing here — the reconnect banner (§5.6) owns it.
- **Rows** (44px, full-width click target):
  - Line 1: unread dot (6px, `--color-accent`, only when unread) · sender
    (`from_name` else `from_email`; Sent/Drafts tabs show `To: {name}`),
    12.5px/650 ink when unread, /600 ink-2 read · right-aligned meta:
    `⌗N` message count (mono, ink-3, only N>1), 📎 (ink-3, only
    `has_attachments`), time (mono ink-3; `14:32` today, `3 Jul` this year,
    `Jul 24` older).
  - Line 2: subject (ink when unread, ink-2 read) ` — ` snippet (ink-3),
    single line, ellipsis.
  - Hover `bg-chrome-mid`; selected `bg-accent-tint` (persists in WIDE as
    the open thread); unread rows carry no background (dot + weight only).
- **Drafts tab rows:** same geometry; line 1 = `To: {names}` + updated time;
  line 2 = subject — body snippet; trailing state chip: `Approved` (outline
  chip, ink-2) or `Send failed` (chip bg rem-tint-10, text ink). No chip for
  `composing`. Opening a draft row opens its thread with studio focused, or
  a thread-less studio for fresh composes.
- **Search:** `/` focuses; input debounced 200ms → `ui_inbox {query}` (FTS).
  While backfill runs, a quiet line above results: `Searching 1,240 synced
  messages so far` (11px ink-3). Esc clears then blurs.
- **Paging:** `ui_inbox {limit: 50, offset}`; IntersectionObserver sentinel
  loads the next page; end of list shows nothing (no "end" furniture).

### 3.3 Thread view

WIDE: fills the thread pane, list stays. NARROW: replaces the list;
header gains `← Inbox`.

```
┌────────────────────────────────────────────────────────────────┐
│ ← Inbox   Re: Q3 budget                          ↩ Reply  ⌫e ⋯│
├────────────────────────────────────────────────────────────────┤
│  ▸ Anna Schmidt · 2 Jul   Sure, let's lock the numbers by…    │ 32px
│  ▸ You · 3 Jul            Attached the first pass — the…      │ 32px
│  ▾ Anna Schmidt — today 14:32                    to you, Ben   │
│                                                                │
│    Hi Paul,                                                    │
│    quick question about the Q3 numbers — can we move the       │
│    infra line into…                (serif 14/1.65, selectable) │
│                                                                │
│  ┌ Draft in progress — Continue ────────────────────────────┐  │
│  └───────────────────────────────────────────────────────────┘  │
│  [ STUDIO — docked here when open, §3.4 ]                      │
└────────────────────────────────────────────────────────────────┘
```

- One scroll context: messages then studio, in flow. The studio **docks
  inside** the thread — the answered message stays directly above it.
- Collapsed rows: `▸ sender · date · snippet` one line, ink-2/ink-3;
  click/Enter expands. Newest message always expanded on open. `▾` header
  of an expanded message collapses it again. Quoted trails inside a body
  collapse behind a `··· show quoted` toggle line (ink-3).
- Header actions: `↩ Reply` (opens/focuses studio), archive, `⋯` menu
  (Mark unread, Open in Gmail ↗ via `https://mail.google.com/mail/u/0/#all/
  {gmail_id}` external link).
- Opening a thread marks it read (`label` remove `UNREAD`, optimistic).
- Existing draft on the thread and studio closed → the `Draft in progress —
  Continue` chip card (border rule-light, hover chrome-mid) sits where the
  studio would dock.

### 3.4 Drafting studio (the crown jewel)

The studio is a bordered region (border-t + border-b rule-light, bg surface)
docked in the thread column. It is **a plain, always-editable editor with a
proposal layer** — it must feel like writing an email in which suggestions
appear, never like reviewing a diff.

```
┌─ STUDIO ───────────────────────────────────────────────────────┐
│ To Anna Schmidt · Cc Ben — Re: Q3 budget          Voice Kurz ▾ │  meta line
├────────────────────────────────────────────────────────────────┤
│ 3 PROPOSED CHANGES · from chat: "reply to Anna"                │  sticky
│ 1 couldn't be placed safely      Accept all ⇧A · Dismiss all ▾ │  header
├────────────────────────────────────────────────────────────────┤
│ ¶  Hi Anna,                                                    │
│                                                                │
│ ¶  ░thanks for the quick turnaround on the numbers░       ←tint│
│    ┌──────────────────────────────────────────────────────┐   │
│    │ ✦ Warmer opening — she signs off informally          │   │
│    │ thanks a lot for turning the numbers around so       │   │
│    │ ░quickly░ — that helps                                │   │
│    │                    Accept ⏎ · Reject ⌫ · Comment C   │   │
│    └──────────────────────────────────────────────────────┘   │
│ ¶  I'd keep the infra line where it is because…                │
│                                                                │
│    2 proposals no longer apply — Dismiss · Re-propose          │  stale line
├────────────────────────────────────────────────────────────────┤
│ [✦ Ask AI to change something…            ]  ⋯   [ Approve ⌘⏎ ]│  footer
└────────────────────────────────────────────────────────────────┘
```

#### 3.4.1 Editor architecture (binding for Wave 3)

Two physical layouts, one visual editor. Both render serif 14/1.65, measure
680px, identical padding, so switching is visually seamless:

- **Write layout** (no pending hunks): ONE auto-growing `<textarea>` holding
  the full body. Native caret, selection, undo.
- **Review layout** (≥1 pending hunk): the body splits on `/\n{2,}/` into a
  stack of per-paragraph auto-growing `<textarea>` blocks (24px gap = the
  blank line). CONTRACTS §4 guarantees hunks never cross paragraph
  boundaries, so each hunk lives inside exactly one block. A paragraph with
  pending hunks renders the **highlight pair**: a backdrop `<div>` (mirrors
  text with `<mark>` spans, `aria-hidden`, identical metrics,
  `white-space: pre-wrap`) behind a textarea with `color: transparent;
  caret-color: var(--color-ink)`. Paragraphs without hunks are plain blocks.
  Every block stays editable at all times.
- Transitions between layouts preserve the caret by mapping paragraph-local
  offsets to body offsets (pure helper, tested). Merging happens when the
  last pending hunk resolves; splitting when a proposal arrives.
- Human typing: instant local echo; debounced 800ms → `draft_edit {draft_id,
  body, base_revision_id}`; **flush on blur** and before any tool call that
  reads the body (accept, approve, propose). `{conflict}` response →
  reload body from `ui_draft`, toast `Draft changed elsewhere — reloaded`.

#### 3.4.2 Hunk presentation

- **Pending, inactive:** the affected span in the body is tinted —
  replacement hunks `--tint-add` (12% mix), deletion hunks (`proposed_text
  === ''`) `--tint-rem` (10% mix). Tint only; no borders, no icons, text
  stays `--color-ink`. Radius 3px on the mark spans.
- **Active (exactly ONE at any moment):** span tint deepens (`--tint-add-hot`
  20% / `--tint-rem-hot` 16%) and its **action strip** inserts in flow
  directly below that paragraph block — content pushes down, nothing
  overlays text.
- **The action strip** (border `rule`, radius 6px, bg surface, left bar 2px
  `--color-add` — or `--color-rem` for deletions — padding 10px 12px):
  - Line 1: ✦ icon (ink-3) + the AI's `note` (sans 12px, ink-2). No note →
    `Suggested change`.
  - Body: the **proposed text** (serif 14/1.65 ink), with word-level changed
    runs marked `--tint-add-word` (24% mix). For deletions: no body, line 1
    reads `Remove this ░sentence|paragraph░` and the tinted body span
    carries `text-decoration: line-through` on the backdrop mark.
  - Action row, right-aligned, quiet text buttons (12px/600 ink-2, hover
    chrome-mid): `Accept ⏎` · `Reject ⌫` · `Comment C`. Left corner, mono
    10.5px ink-3: `2 / 3`.
  - The strip is one focusable group (`tabindex=0`, `role="group"`,
    `aria-label="Proposed change 2 of 3: {note}"`). When focused, its keys
    are live (§5.1 strip scope).
- **Sticky proposal header** (sticks to studio top while scrolled, bg
  chrome-high, border-b rule-light, 32px): micro label `N PROPOSED CHANGES`
  (counts **remaining pending**), origin (`from chat: "{intent…}"` /
  `from you` / `from learning`, 11px ink-3, intent truncated 40ch), the
  dropped-honesty fragment when >0: `M couldn't be placed safely` (ink-3,
  title attr explains: "The draft changed since the AI read it; these
  suggestions were dropped rather than guessed."), and right: `Accept all`
  (12px/600 **ink**, hover chrome-mid — the effortless path gets the
  strongest text weight, not an accent fill) · `Dismiss all ▾` (opens a
  2-row menu: `Not this time` → `proposal_dismiss`; `I'll take it from
  here` → `proposal_dismiss {takeover: true}`, menu row subtitle: "tells
  the AI to stop suggesting on this draft").
- **Typing-over (demotion):** first keystroke in a paragraph containing
  pending hunks instantly (synchronously, before the debounce) drops those
  hunks' tints to `--color-chrome-mid` and, if one was active, hides its
  strip — visual demotion is immediate, the ledger write follows ≤1s. When
  `draft_edit` returns `hunk_changes`: still-valid hunks re-tint; stale ones
  collapse into the stale line.
- **Stale line** (one line, never cards): `N proposals no longer apply —
  Dismiss · Re-propose` (ink-3; actions ink-2/600 hover chrome-mid).
  Dismiss = resolve stales silently; Re-propose = `draft_propose` with the
  parent proposal's `intent_text`. Sits at the bottom of the editor region.
- **Cycling:** Tab / j / k / ⇧Tab move the active hunk in document order
  (wrap at ends). Clicking a tinted span activates that hunk. Cycling moves
  focus to the strip; the editor scrolls the pair into view
  (`scrollIntoView {block:'center'}`).

#### 3.4.3 Meta line, voice, Ask AI, footer

- **Meta line (replies):** one quiet line `To Anna Schmidt · Cc Ben — Re: Q3
  budget` (12px, ink-2, hover chrome-mid). Click expands to the full meta
  editor: To/Cc/Bcc chip inputs + subject input (each commits on
  blur/Enter → `draft_update_meta`). Fresh composes open expanded with
  focus in To. Invalid address chips: chip bg rem-tint-10, kept editable.
- **Voice select:** compact custom listbox (Board field-menu pattern; 24px
  trigger, `Voice {name} ▾`). Change → `draft_update_meta {voice_id}`. Menu
  rows show name + one-line description (ink-3).
- **Ask AI input** (footer, flexes): placeholder `✦ Ask AI to change
  something…`; on an **empty draft** it reads `✦ Tell the AI what this email
  should say…` (→ ai_initial path, TOOL-GAP #4). Enter →
  `draft_propose {draft_id, intent, paragraphs?}`; input shows inline
  spinner + `Proposing…`; editing remains fully available. A scope chip
  `¶3 ×` appears in the input when scoped via the gutter.
- **¶ paragraph gutter:** 20px gutter left of the editor, empty by default.
  Hovering a paragraph reveals `¶` (ink-4→ink-2 on hover, bg chrome-mid
  16×16px). Click = scope the Ask-AI input to that paragraph (chip appears,
  input focuses). It is hover-only decoration with a keyboard equivalent:
  the Ask-AI input accepts `¶3 ` prefix typed manually (parsed to scope).
- **Footer** (40px, border-t rule-light): Ask-AI input · `⋯` overflow menu
  (`History…`, `Discard draft` danger row) · primary button. Wraps to two
  rows below 560px (input full-width on top).
- **History** (menu action, no persistent timeline): opens a floating panel
  listing revisions (`ui_draft` meta): `#12 · proposal accept · 14:32`,
  `#11 · you · 14:30`, source-labeled in plain words (you / AI draft /
  accepted change / restore). Select → read-only body preview with
  `Restore this version` button. Requires TOOL-GAP #1 tools; until they
  land, the panel lists meta only and the preview area says `Restoring
  needs Wave 2` — do not fake it.

#### 3.4.4 Approve → confirm card → Send

- Primary button states: `composing` → **Approve** (accent fill, 13px/700
  accent-ink); `approved` → **Send…** (same style). ⌘⏎ triggers it.
- Approve = flush edits → `draft_approve {draft_id, revision_id}` → the
  **confirm card** docks over the footer region (in flow, pushing footer
  out; border `rule`, radius 8px, bg chrome-high):

```
┌ Send this email? ──────────────────────────────────┐
│ To       Anna Schmidt <anna.schmidt@acme.de>       │
│ Cc       Ben Ortiz <ben@acme.de>                   │
│ Subject  Re: Q3 budget                             │
│ Voice    Kurz & direkt                             │
│ ☑ Include quoted thread below your reply           │
│                                                    │
│                          Cancel      [ Send ⌘⏎ ]  │
└────────────────────────────────────────────────────┘
```

  - Recipients verbatim with full addresses — this is the human gate; no
    survival score, no AI copy here.
  - Focus lands on **Send** but the card ignores Enter/⌘⏎ for its first
    250ms (anti double-fire from a fast ⌘⏎⌘⏎).
  - `Cancel`/Esc closes the card; draft stays `approved`; the primary
    button now reads `Send…` (reopens the card — Send **always** passes
    through the card).
  - Any edit while approved/card open: card closes, quiet inline note above
    footer `Draft changed — approval reset` (ink-3, 4s), button returns to
    Approve (backend reverts state; UI mirrors).
  - Send: button → `Sending…` spinner, card locked. Success: card resolves,
    studio unmounts, sent message appears in the thread (mirrored locally
    by the backend), toast `Sent to Anna Schmidt`. Failure: card is
    replaced by an error card (bg rem-tint-10, border rule): verbatim
    `last_send_error` + `Retry` + `Back to draft`.
- **⌘⏎ is the only accelerator on this path and has no meaning anywhere
  near hunks; Accept-all is ⇧A (strip scope) or a click — the two can never
  be confused or chained.**

### 3.5 Voices & Learning

One surface (route `voices`). Voice chips row + the standard editor (the
same modules as the studio — voice docs are reviewed with the identical
hunk mechanic) + learning panel.

```
┌────────────────────────────────────────────────────────────────┐
│ ← Inbox   Voices & Learning                    Distill lessons │
│ [ Kurz & direkt ●] [ Formell DE ] [ Warm intros ]              │
├───────────────────────────────────────────┬────────────────────┤
│ # Kurz & direkt                (md, serif)│ LEARNING           │
│ Greeting: "Hi {first}," — never "Hallo    │ First-draft        │
│ zusammen"…                                │ survival           │
│ ░Prefer one-sentence sign-offs░       tint│  ▁▃▄▆▅▇  74%       │
│ ┌ ✦ From your last 5 sends: you cut       │  12 scored sends   │
│ │ pleasantries in 4 of 5 openings…        │ ────────────────   │
│ │            Accept ⏎ · Reject ⌫ · C      │ Untouched funnel   │
│ └──────────────────────────────────────── │  34 drafted        │
│ (doc is always editable, human edits →    │  28 sent           │
│  voice_update, debounced like the studio) │   9 untouched      │
│                                           │ ────────────────   │
│                                           │ Recent lessons     │
│                                           │ "too formal for    │
│                                           │  Anna" · 2d        │
│                                           │ "never bullet      │
│                                           │  points" · 5d      │
└───────────────────────────────────────────┴────────────────────┘
```

- **Voice chips:** Board tab-pill grammar; a 5px accent dot marks voices
  with pending flywheel proposals. Freshly seeded voices show a one-time
  banner above the doc: `Here's my first read of how you write — correct
  me.` (bg chrome-high, border rule-light, ✦ icon — never an accent fill)
  with `Looks right` (dismiss); editing the doc also dismisses it.
- **Doc editor:** same write/review layouts as §3.4.1 against
  `body_md`/voice proposals; sticky header origin reads `from learning`.
  Accept/reject/comment use the same `hunk_*` tools (proposals are
  polymorphic). Human edits → `voice_update {voice_id, body_md}` debounced
  800ms + blur flush.
- **Distill lessons** (header, quiet button): `jobs_kick {job:'flywheel'}` →
  button `Distilling…`; on completion with no proposals, toast `Not enough
  new sends to learn from yet` (the backend exits quietly; the UI must
  still answer the click honestly).
- **Learning panel** (bg chrome-high, border-l rule-light, 240px; micro
  labels; all numbers mono):
  - **Survival trend:** per selected voice. `scored_sends >= 10` → 36px
    sparkline (1.5px `--color-ink-3` line, last point 3px `--color-accent`
    dot, no axes; ISO-week means from `survival_trend`), current mean as
    `74%` (mono 14px ink) + `12 scored sends` (10.5px ink-3). Below 10 →
    no chart, no fake numbers: `collecting — 4 of 10` (mono ink-3) with a
    10-segment dot row (filled dots ink-3, empty rule-light).
  - **Untouched funnel:** three rows `34 drafted / 28 sent / 9 untouched`,
    each with a proportional 3px bar: `--color-rule` for the first two,
    `--color-add` for the untouched row. The numbers are the information;
    bars are redundant decoration (exempt from text-contrast rules).
  - **Recent lessons:** rejection comments verbatim (`metrics.lessons`),
    quoted, serif 12px ink-2, relative time mono ink-4 (time is redundant
    meta). Empty: `No lessons yet — reject a suggestion with a note and it
    lands here.` (11px ink-3).
- Voice rename/archive: header `⋯` per voice — blocked on TOOL-GAP #2;
  until then the menu omits these rows entirely (never disabled teasers).

### 3.6 Settings popover

Gear in header → Board settings-popover pattern (260px, border rule,
radius 8px, shadow allowed — floating). Rows:
`{email}` (mono, ink-3) · `Sync window  [90d ▾]` (`settings_set`) ·
`Re-seed voices` (`jobs_kick seed_voices`) · sep · `Disconnect` (danger,
two-click confirm inline: `Disconnect — sure?`). Disconnect keeps the
mirror (copy: `Keeps your local mail; removes the Google connection.` as
title tooltip).

---

## 4. Proposal review feel (moment-to-moment)

Design intent: **accept-all-after-reading is the effortless common path;
hunk-by-hunk is available, not mandatory. It must feel like a colleague's
pencil marks on your letter, not a pull request.** Concretely:

- **1 pending hunk** (the typical `hunk_comment` revision loop): the hunk
  arrives already active — tinted span + strip visible in place, zero
  clicks to read. One key resolves it (⏎ or ⌫). After resolution the strip
  slides out (120ms height collapse — a content transition, allowed), the
  layouts merge, the caret sits right after the change. Total cost of the
  common loop: read, press ⏎, keep typing.
- **3 pending hunks:** header appears (`3 PROPOSED CHANGES · from chat:
  "reply to Anna"`). All three spans are tinted; #1 is active. The user
  reads the email top-to-bottom as an email — tints show where, the active
  strip shows the first what. Tab, Tab previews the rest; at any point ⇧A
  (or click `Accept all`) resolves the remainder. Or they ignore the layer
  entirely and keep typing — nothing blocks the caret, ever.
- **8 pending hunks** (heavy revision): same mechanics, no new UI. The
  header count is the orientation (`8 PROPOSED CHANGES`, decrementing as
  they resolve); cycling wraps; the stale line absorbs any hunks their own
  edits invalidate. If it feels like too much, `Dismiss all ▾ → I'll take
  it from here` is one gesture and is honest with the flywheel
  (`human_takeover`). We deliberately ship **no** minimap, no side-by-side
  diff, no per-hunk checkboxes — those are code-review furniture.
- **Reading order guarantee:** active-hunk order is document order, always.
  Accepting never re-orders; re-anchoring never moves a pending hunk's
  position in the cycle (spans re-anchor by content).
- **Typing over a suggestion is a first-class decision**, not an error:
  instant demotion (§3.4.2), no confirmation, no warning. The stale line is
  the only trace, and it is calm.
- **Comment C** opens a one-line input docked inside the strip
  (placeholder `What's wrong with this change?`). Enter → `Ask to revise`
  (`hunk_comment` — supersedes the proposal, strip shows `Revising…`
  shimmer until the new proposal lands, then the new hunk is active).
  The secondary button `Reject with note` (`hunk_reject {comment}`) records
  the verbatim note for the flywheel and resolves the hunk. Esc returns to
  the strip.
- **Dropped-hunk honesty:** the header fragment `M couldn't be placed
  safely` appears whenever `dropped > 0` — same size, same row, never a
  toast, never hidden in a tooltip (the tooltip only adds the why).

---

## 5. Interaction contract

### 5.1 Keyboard map

Input guard (Board `shortcuts.js` pattern, extended): single-key shortcuts
are dead while `document.activeElement` is INPUT/TEXTAREA/SELECT/
contenteditable — except the keys explicitly marked **editor** or **strip**
below, which are scoped by focus location, and Esc, which always works.

| Scope | Key | Action |
|---|---|---|
| global | `Esc` | Close top layer: menu → comment box → confirm card → strip focus (to editor) → search clear/blur → thread (NARROW, to list) |
| global | `/` | Focus search (routes to Inbox if elsewhere) |
| list | `j` / `↓`, `k` / `↑` | Move selection (WIDE: opens the thread as it moves — selection IS the open thread; NARROW: moves highlight only) |
| list | `o` / `Enter` | Open selected thread (NARROW) / focus thread pane (WIDE) |
| list | `e` | Archive selected thread, select next |
| list | `r` | Open thread + open/focus studio (reply) |
| list | `c` | Compose new draft |
| list | `1 2 3 4` | Tabs Inbox / All / Sent / Drafts |
| thread | `j` / `k` | Next/prev thread (list selection advances, thread follows) |
| thread | `e` | Archive this thread → next thread (NARROW: back to list) |
| thread | `r` | Open/focus studio |
| thread | `u` | Back to list (NARROW) / focus list (WIDE) |
| thread | `Enter` | Toggle expand on focused collapsed message |
| editor (textarea focused, pending hunks exist) | `Tab` / `⇧Tab` | Activate next/previous hunk (focus its strip). With no pending hunks Tab follows native DOM order — no capture |
| editor | `⌘⏎` | Approve / Send… (primary path) |
| editor | `Esc` | Blur editor (focus studio container; next Tab follows DOM) |
| strip (strip focused) | `⏎` | Accept hunk |
| strip | `⌫` / `Delete` | Reject hunk (no comment) |
| strip | `c` | Open comment box |
| strip | `Tab`/`j` · `⇧Tab`/`k` | Next / previous hunk |
| strip | `⇧A` | Accept all remaining |
| strip | `Esc` | Return focus to the hunk's textarea, caret at hunk start |
| confirm card | `⏎` | Native: activates the FOCUSED button (Send by default; a focused Cancel cancels) |
| confirm card | `⌘⏎` | Send — the only send accelerator (dead for first 250ms after open; inert unless focus is within the studio) |
| confirm card | `Esc` | Cancel |
| dialogs/menus | standard | Arrow keys cycle rows, Enter activates, Esc closes, focus trapped, focus returns to invoker |

No other shortcuts exist. Every shortcut appears in the owning control's
`title`. There is deliberately **no shortcut** for Dismiss all, Discard,
Disconnect, or Send-without-card.

### 5.2 Focus management (binding table)

| Event | Focus goes to |
|---|---|
| App boot, connected | Thread list (first row selected, not opened NARROW) |
| Onboarding step advances | The step's primary control (link row / textarea / button) |
| Studio opens via `r`/Reply | Editor textarea, caret at end (reply) |
| Studio opens via Compose | To chip input (meta expanded) |
| Studio opens on a draft with pending proposal | Active (first pending) hunk strip — review is the task |
| Proposal arrives while user is typing/elsewhere | **Never steals focus.** Header + tints appear; aria-live polite announces `3 changes proposed` |
| Proposal arrives from own Ask-AI, focus still in Ask-AI input | First hunk strip |
| Hunk accepted/rejected/commented-away | Next pending strip; if none: the paragraph's textarea, caret after the change site (layouts merge) |
| Dismiss all / take over | Editor textarea, caret preserved |
| Approve clicked / ⌘⏎ | Confirm card Send button (250ms key guard) |
| Confirm card cancelled | Primary button (`Send…`) |
| Send succeeds | Thread list, selection on this thread (j/k triage continues) |
| Send fails | `Retry` button in the error card |
| Comment box opens | Its input; Esc → strip |
| Menu/dialog/popover closes | Its invoker |
| Reconnect banner appears | No focus steal; aria-live assertive announcement |

Focus is never lost to `<body>`: every unmount hands focus to the mapped
target above (audited, §8.6).

### 5.3 Selection / hover / active states per element class

| Element | Default | Hover | Active/selected | Focus-visible |
|---|---|---|---|---|
| List row | bg none | `chrome-mid` | `accent-tint` (open thread) | ring |
| Collapsed message row | bg none, ink-2 | `chrome-mid` | — (expands) | ring |
| Tab pill | border rule-light, ink-3 | `chrome-mid`, ink-2 | `chrome-mid` + border rule + ink-2 | ring |
| Icon button 26px | ink-3 | `chrome-mid` + ink | `accent-tint` + accent (toggled) | ring |
| Quiet text button | ink-2/600 | `chrome-mid` | — | ring |
| Primary button | `accent` fill, accent-ink 13/700 | opacity .9 | disabled: opacity .55 | ring offset 2 |
| Danger row (menus) | text ink-2 | bg rem-tint-10, text ink | — | ring |
| Hunk span (inactive) | tint 12/10% | — (span itself not hoverable) | active: tint 20/16% | — (strip carries focus) |
| Strip | border rule, left bar add/rem | — | — | `border-color: accent` + ring |
| ¶ gutter mark | hidden | visible ink-2 on `chrome-mid` 16px chip | scoped: stays visible, accent | ring |
| Inputs/textarea | border rule (tokens.css) | — | — | border accent (tokens.css default) |
| Voice chip | pill, ink-3 | `chrome-mid` | selected: `chrome-mid` + border rule + ink | ring |
| Link (`<a>` only) | accent underline | — | — | ring |

Focus ring everywhere: `outline: 1.5px solid var(--color-accent);
outline-offset: 1px` on `:focus-visible` only. Hover changes are instant
(no transitions); the only animations: strip insert/collapse height (120ms)
and the ai_initial tint wash (400ms fade) — content reveals, not hover.

### 5.4 Optimistic vs explicit progress

- **Local ops (SQLite via tools) are optimistic** — apply the UI result
  immediately, reconcile with the tool response, revert + inline error on
  failure. No spinners for: hunk accept/reject, dismiss, typing/draft_edit,
  archive/read-state, tab switch, meta edits, voice edits, settings.
  (Latency budget: if any of these exceeds 150ms in practice, that is a
  backend bug to file, not a spinner to add.)
- **Network/AI ops get explicit progress within 100ms and explicit
  endings**: connect (button states + countdown), send (`Sending…` in the
  card), sync/backfill (header cell + accent line), propose/revise
  (`Proposing…`/`Revising…` inline), distill (`Distilling…` button), seed.
  None of them ever blocks typing or navigation.

### 5.5 Toast vs inline error policy

- **Toasts** (Board `toast.js` + one optional action, bottom-center, 1.6s;
  5s when carrying an action; `aria-live="polite"`): success/undo
  confirmations whose surface is gone or unchanged — `Sent to {name}`,
  `Archived · Undo` (Undo re-adds `INBOX` via `label`), `Link copied`,
  `Draft discarded` (no Undo — no un-discard tool), `Not enough new sends
  to learn from yet`.
- **Inline, never toasts:** every error and every state that needs an
  action — send failure (error card), connect errors (step card), sync
  failure (header cell), auth expiry (banner), JSON validation (under
  field), draft conflict (toast is acceptable here because the resolution
  is automatic: `Draft changed elsewhere — reloaded`).
- Errors never auto-dismiss; confirmations never modal; nothing important
  lives only in a 1.6s toast.

### 5.6 Empty / loading / error / reconnect matrix

| Surface | Loading | Empty | Error | Notes |
|---|---|---|---|---|
| Inbox list | Skeleton rows (Board `skel-*`, 8 rows) on first paint only; pagination appends silently | `Inbox zero.` (13px ink-3, centered; Sent: `Nothing sent in this window.`; Drafts: `No drafts.`; search: `No matches for "{q}".`) | Header sync cell `sync failed · Retry`; list keeps last good data | During backfill the list streams in — new rows appear on the 2.5s poll, **no** full-list spinner |
| Thread | Instant from mirror (no spinner; if uncached, 3 skeleton lines) | — (unreachable) | `Couldn't load this thread · Retry` inline | |
| Studio | Skeleton paragraph shimmer only for ai_initial generation | Empty body: Ask-AI placeholder variant (§3.4.3) | propose failure: strip-shaped inline card `The AI couldn't produce a valid change here — Try again` (proposal `invalidated`); send failure: §3.4.4 error card | Draft never lost on any failure |
| Voices | Chips + doc from cache | Pre-seed: `Your voices are being read from your sent mail…` with progress if seed running, else `Seed voices` button (`jobs_kick`) | Seed/flywheel job error: inline line under chips + `Retry` | |
| Onboarding | — | — | §3.1 per-step inline | |
| **Auth expiry** | — | — | **Reconnect banner**, full-width under header: bg `color-mix(in srgb, var(--color-rem) 10%, var(--color-surface))`, border-b rule-light, ⚠ ink-2, text ink `Gmail connection expired — your mail is paused.` + `Reconnect` (primary-quiet, runs `connect_start` flow inline) | Triggered by `connect_status.token_ok === false` (checked on the 75s timer, on window focus, and after any failed job). **A stale inbox is never silent**; while the banner shows, the sync cell shows nothing (banner owns the state) |

Reconnect keeps the mirror and all drafts; the banner replaces onboarding
for the re-auth case (client JSON already stored → skip to consent).

### 5.7 Data heartbeat

- Boot: `package.capabilities.list` → tool map (§7.2) → `connect_status` →
  route. Then `ui_inbox` first page.
- While visible: every 75s → `jobs_kick {job:'sync'}` + `connect_status`;
  4s after a kick, refetch the active surface. On `visibilitychange` →
  visible: immediate cycle.
- While `backfill_state === 'running'`: poll `connect_status` + active
  surface every 2.5s (streaming inbox feel).
- Manual ⟳: same as a timer cycle, icon spins until the refetch lands.

---

## 6. Visual spec

### 6.1 Token usage per element (bg / border / text)

| Element | bg | border | text |
|---|---|---|---|
| Header, tab row, list, thread, studio body | `surface` | `rule-light` dividers | per type scale |
| Sticky proposal header | `chrome-high` | b `rule-light` | micro label ink-3 · actions ink/ink-2 |
| Learning panel | `chrome-high` | l `rule-light` | labels ink-3, numbers ink (mono) |
| Action strip / confirm card / history panel | `surface` / `chrome-high` (card) | `rule` | note ink-2 · body ink |
| Hover fills (all) | `chrome-mid` | — | one ink level darker |
| Selected row / toggled icon | `accent-tint` | — | ink (icon accent) |
| Primary button | `accent` | — | `accent-ink` 13/700 |
| Warning/error cards, banner, Send-failed chip | rem-tint-10 (§6.2) | `rule-light` | **ink / ink-2 only** |
| Success confirmation row (onboarding) | add-tint-12 | `rule-light` | ink |
| Toast | `surface` | `rule` | ink-2 (floating: shadow allowed) |
| Skeletons | `chrome-mid` / `chrome-high` | `rule-light` | — |
| Accent appearances (exhaustive) | — | — | unread dot, progress line, focus rings, primary buttons, voice-pending dot, sparkline end-dot, toggled icon buttons, caret. **Never a large fill, never text-on-tint.** |

### 6.2 Tint formulas (define once as CSS custom properties on `:root`)

```css
--tint-add:      color-mix(in srgb, var(--color-add) 12%, var(--color-surface));
--tint-add-hot:  color-mix(in srgb, var(--color-add) 20%, var(--color-surface));
--tint-add-word: color-mix(in srgb, var(--color-add) 24%, var(--color-surface));
--tint-rem:      color-mix(in srgb, var(--color-rem) 10%, var(--color-surface));
--tint-rem-hot:  color-mix(in srgb, var(--color-rem) 16%, var(--color-surface));
--tint-demoted:  var(--color-chrome-mid);
```

These are theme-agnostic: mixing into `--color-surface` produces a light
wash on light themes and a dark wash on dark themes automatically.
`--color-rem` is used **only** inside `color-mix` backgrounds and as the
2px deletion strip bar — never as a text color (accent collision).

### 6.3 Contrast table (WCAG)

Measured on the default `tokens.css` values (sRGB `color-mix`, WCAG 2.1
relative luminance). The Floor column is what the 8-theme host contract
plus rules §1.4 guarantee; the audit (§8.2) re-measures every row in all 8
themes.

| Pair | Default | Floor basis | AA (4.5) |
|---|---|---|---|
| ink / surface | 17.43 | host ≥8.0 | pass |
| ink-2 / surface | 8.92 | host ≥5.5 | pass |
| ink-3 / surface | 5.87 | host ≥4.5 | pass |
| ink / chrome-high | 16.15 | host ≥8.0 | pass |
| ink-2 / chrome-high | 8.26 | host ≥5.5 | pass |
| ink-3 / chrome-high | 5.44 | host ≥4.5 | pass |
| ink / chrome-mid (hover, demoted tint) | 14.92 | host ≥8.0 | pass |
| ink-2 / chrome-mid | 7.63 | host ≥5.5 | pass |
| ink-3 / chrome-mid | 5.03 | host ≥4.5 | pass |
| ink / add-tint-12 `#ecf1e8` | 15.20 | rule §1.4-2 | pass |
| ink-2 / add-tint-12 | 7.78 | rule §1.4-2 | pass |
| ink / add-tint-20 (hot) | 13.84 | rule §1.4-2 | pass |
| ink-2 / add-tint-20 | 7.08 | rule §1.4-2 | pass |
| ink / add-tint-24 (word marks) | 13.14 | rule §1.4-2 | pass |
| ink / rem-tint-10 `#f9efec` | 15.43 | rule §1.4-2 | pass |
| ink-2 / rem-tint-10 | 7.89 | rule §1.4-2 | pass |
| ink / rem-tint-16 (hot) | 14.25 | rule §1.4-2 | pass |
| ink-2 / rem-tint-16 | 7.29 | rule §1.4-2 | pass |
| add bar / surface (UI component, 3:1) | 4.01 | ≥3 | pass |
| rem bar, accent ring / surface (UI, 3:1) | 4.31 | ≥3 | pass |
| accent text / surface (≥12px/600 only) | 4.31 | host ≥3.0, large-text AA | pass (as used) |
| accent-ink / accent (primary buttons) | 4.31 | host-owned pair | **4.31 < 4.5** — mitigated: 13px/700, large target; identical exposure to Board/host. Logged for the host contrast contract (audit re-checks per theme; if any theme <3.0, escalate to mim-os `docs/issues.md`) |

Dark-theme worst-case simulation (surface `#232629`, bright add/rem):
ink on add-20 ≈ 8.5, ink-2 on add-20 ≈ 4.95, ink on rem-16 ≈ 9.7, ink-2 on
rem-16 ≈ 5.6 — the §1.4-2 rule (ink/ink-2 only on tints) holds with margin.
If any real theme measures <4.5 for ink-2-on-hot-tint at audit, the fix is
lowering the hot mix to 16%/12% globally — not per-theme forks.

### 6.4 Iconography

Inline SVG sprite (Board `icons.js` pattern): 24×24 viewBox, `fill: none`,
`stroke: currentColor`, `stroke-width: 2`, round caps/joins, rendered at
13–16px. Required set (21):

`envelope, compose (pen), reply, archive (box + down arrow), refresh, gear,
search, chevron-down, chevron-right, arrow-left, check, checks (double,
accept-all), x, comment (speech bubble + dot), sparkle (✦ AI origin),
clock (history), send (paper plane), alert-triangle, trash, dots
(overflow), paperclip`. The ¶ gutter mark and ✦ in text lines may be text
glyphs in sans, not SVG. No third-party icon fonts; no emoji in chrome.

### 6.5 App icon (`ui/icon.svg`)

Monochrome envelope mark matching Mim's sidebar grammar: 24×24 viewBox,
`stroke="currentColor"`, `stroke-width="1.8"`, no fill —
`<rect x="3" y="5.5" width="18" height="13" rx="2"/>` +
`<path d="M3.5 7l8.5 6 8.5-6"/>`. No brand color, no gradients; the host
tints it via `currentColor` like every other app token.

---

## 7. Component inventory (Wave 3 file ownership)

Vanilla ES modules, Board conventions: browser modules `.js`, co-located
tests `*.test.mjs` (repo-root vitest picks them up), no deps, no build.
Pure logic lives in modules that import no DOM so tests stay node-only.

| File | Responsibility (owner may not exceed it) |
|---|---|
| `ui/index.html` | Shell: theme-fragment bootstrap + postMessage token listener (Board verbatim), tokens.css link, svg defs, layer divs (`#content #bannerLayer #menuLayer #toastLayer`), base CSS (§1–§2 geometry, all element classes of §5.3/§6.1), skeleton first paint |
| `ui/js/state.js` | The store + `render()` registry + `closeTopLayer()` + `showToast(msg, action?)` (shape below) |
| `ui/js/data.js` | Tool discovery + `call()` + all backend calls + heartbeat timers (§5.7) + optimistic helpers (apply/reconcile/revert) |
| `ui/js/render.js` | Root dispatch by `state.route`, banner + toast mounting, ResizeObserver breakpoint |
| `ui/js/onboarding.js` | §3.1 view + `validateClientJson()` (pure, exported) |
| `ui/js/inbox.js` | Header, tabs, search, sync cell, list rows, paging sentinel |
| `ui/js/thread.js` | Thread column, collapse/expand, quoted-trail folding, draft chip |
| `ui/js/studio.js` | Studio orchestration: meta line, voice select, Ask-AI, footer, approve/confirm/send state machine |
| `ui/js/editor.js` | **Pure paragraph engine**: `splitParagraphs`, offset↔paragraph caret mapping, write/review layout mount, highlight-pair renderer, auto-grow. Heaviest test target |
| `ui/js/hunks.js` | **Pure hunk view-model**: document-order sort, active-cycling reducer, demotion, stale collapse, word-level diff for strip preview (`diffWords(a,b)` LCS on tokens), strip rendering |
| `ui/js/voices.js` | §3.5 surface; reuses editor.js/hunks.js; sparkline + funnel + lessons renderers |
| `ui/js/shortcuts.js` | Scope-aware keymap (§5.1) with the Board input guard; scope = f(focus location, route) |
| `ui/js/toast.js` | Board toast + optional single action button |
| `ui/js/icons.js` | Sprite (§6.4) |
| `ui/js/utils.js` | `escapeHtml, qs, debounce, fmtTime, fmtCount` |

Tests (minimum): `editor.test.mjs` (split/merge, caret mapping, metrics
classes), `hunks.test.mjs` (cycle order, demotion, stale, diffWords),
`onboarding.test.mjs` (validator table incl. `web`-client case),
`shortcuts.test.mjs` (scope resolution + input guard), `state.test.mjs`.

### 7.1 Store shape (`state.js`)

```js
export const state = {
  tools: {},              // export key -> publicName (§7.2); empty until boot
  breakpoint: 'wide',     // 'wide' | 'narrow'  (ResizeObserver)
  route: { view: 'inbox', threadId: null, draftId: null },
                          // view: 'onboarding'|'inbox'|'thread'|'voices'
  conn: { connected: false, email: '', tokenOk: true,
          backfill: { state: 'pending', done: 0, total: 0 },
          lastSyncAt: null, syncError: '' },
  inbox: { tab: 'inbox', query: '', threads: [], offset: 0,
           exhausted: false, loading: false, selectedId: null },
  thread: { thread: null, messages: [], drafts: [], expanded: new Set() },
  studio: {
    open: false, draft: null, body: '', baseRevisionId: null,
    dirty: false, metaExpanded: false,
    proposal: null,       // { id, origin, intent, dropped, hunks: [...] }
    activeHunkId: null, demoted: new Set(), stale: [],
    askAi: { text: '', scope: null, pending: false },
    confirm: null,        // null | 'card' | 'sending' | { error }
    commentFor: null,     // hunkId with open comment box
  },
  voices: { list: [], activeId: null, proposal: null, metrics: null,
            lessons: [], seedBanner: false },
  onboarding: { step: 1, json: '', validation: null, connecting: false,
                consentUrl: '', deadline: 0, error: '' },
  banner: null,           // null | 'reconnect'
  toast: { msg: '', action: null },
  menus: { settings: false, voicePicker: false, dismissAll: false,
           overflow: false, history: false },
}
```

### 7.2 Data patterns (`data.js`)

```js
import { runtime } from '/sdk/mim.js'

// Boot discovery — never hardcode the pkg_<hash> prefix (CONTRACTS §3.2)
const caps = await runtime.call('package.capabilities.list', {})
const mailTools = caps.tools.filter(t => t.packageId === 'mail')
state.tools = Object.fromEntries(mailTools.map(t => [t.exportKey, t.publicName]))
// (exact field names verified against the real response in Wave 3 setup;
//  both the ui-only set and the named set are mapped the same way)

export const call = (key, input = {}) =>
  runtime.call('package.tools.execute', { name: state.tools[key], input })

// examples
call('ui_inbox', { tab, query, limit: 50, offset })
call('hunk_accept', { hunk_id })            // optimistic: apply local, reconcile with returned body
call('draft_edit', { draft_id, body, base_revision_id })  // debounced 800ms + blur flush
call('label', { thread_id, remove: ['INBOX'] })           // archive (named tool, ui actor)
call('draft_propose', { draft_id, intent, paragraphs })   // Ask-AI (origin: see TOOL-GAP #3)
```

Errors: every `call` result may be `{error}` (CONTRACTS §10) — `data.js`
normalizes to `{ok, value, error}`; views route errors per §5.5/§5.6.

---

## 8. Excellence checklist (the audit gate)

Each item is measured, not vibes. The audit runs at 336px, 700px, 1100px in
White + Slate minimum, plus token-level checks across all 8 themes.

1. **Keyboard reachability:** every interactive element is reachable by Tab
   in DOM order matching visual order; every §5.1 shortcut works; zero
   keyboard traps (Esc exits strip focus, editor Tab-capture only exists
   while pending hunks exist, and is announced via `aria-describedby`).
2. **Contrast:** every informational text node uses ink/ink-2/ink-3 per
   §1.4; tinted backgrounds carry only ink/ink-2; re-measure every §6.3
   pair in all 8 themes' actual tokens — all ≥4.5:1 (UI components ≥3:1).
3. **Studio at 700px:** zero horizontal scroll anywhere; at 336px every
   surface remains operable (controls wrap, nothing clipped, editor
   usable).
4. **One-active-hunk invariant:** with N pending hunks exactly one strip is
   in the DOM at any time; cycle order equals document order; wraps; click
   activation matches.
5. **Optimistic/progress policy:** no spinner on any local op; every
   network/AI op shows progress ≤100ms after trigger and has an explicit
   terminal state; grep-level check that no failure path ends in a bare
   toast or silence.
6. **Focus ledger:** every event in §5.2 lands focus on the specified
   target (manual walkthrough); focus never falls to `<body>`.
7. **Reconnect honesty:** with `token_ok:false` injected, the banner
   appears within one heartbeat and the sync cell yields to it; killing the
   token mid-backfill also raises it; the inbox is never stale without the
   banner.
8. **Token purity:** no hex/rgb literals outside `tokens.css` and
   `--tint-*` definitions (grep `#[0-9a-f]{3,8}\b|rgb\(` over `ui/` —
   allowed: none); `--color-rem` appears only in `color-mix` backgrounds
   and the deletion strip bar; accent appears only in the §6.1 exhaustive
   list.
9. **Review feel:** from proposal arrival, accept-all is ≤2 gestures
   (read → `Accept all`/⇧A); hunk-by-hunk path is fully keyboardable
   (⏎/⌫/c/Tab only); typing is never blocked or interrupted by the
   proposal layer (type-during-propose test); demotion is visually
   instant (<1 frame) with the ledger write ≤1s behind.
10. **ARIA + live regions:** strips announce `Proposed change i of N:
    {note}`; proposal arrival, toasts polite; banner assertive; dialogs
    `role=dialog aria-modal` with trap + return; confirm card
    `role=alertdialog`; sync progress `aria-live=polite` throttled to
    state changes (not every count tick); the thread list is
    `role="listbox"` with `role="option"` full-row buttons carrying
    `aria-selected` (a plain `role="list"` would strip the buttons'
    semantics).

---

## 9. TOOL-GAPS (for Wave 2 — ui-only additions unless noted)

1. **`revision_get {revision_id}` + `draft_revert {draft_id, revision_id}`**
   — History (§3.4.3) needs revision bodies to preview and a revert that
   creates a `source:'revert'` revision. Without them History is meta-only.
2. **Voice metadata:** `voice_update` only takes `body_md`; seeded voices
   are presented "for rename/edit/merge" (plan §7) but there is no rename/
   description/archive path. Extend `voice_update` with optional
   `{name?, description?, archived?}` or add `voice_meta`.
3. **`draft_propose` origin from UI:** CONTRACTS §3.1 gives it no origin
   input; the backend must derive `user_request` vs `chat_agent` from
   `ctx.actor` — confirm in Wave 2 or the flywheel mis-attributes UI asks.
4. **Ask-AI on an empty draft:** no tool triggers `ai_initial` on an
   *existing* empty draft (`draft_create` only does it at creation).
   `draft_propose` should route to `ai_initial` when the body is empty.
5. **`runtime.secrets` from the app iframe:** plan §5 assumes the UI can
   store `google_oauth_client` directly; if the SDK doesn't expose secrets
   writes to iframes, add ui-only `client_set {json}` (validate + store).
6. **`ui_inbox` Drafts tab:** confirm `tab:'drafts'` is supported with the
   §3.2 row fields (to, subject, snippet, state, updated_at); otherwise the
   UI composes it from `drafts` (fallback exists — low priority).
7. **Voices-ready nudge:** no push channel; the Voices dot/banner needs a
   `seed_state` field on `connect_status` (or `ui_voices`) to avoid an
   extra polling loop.
8. **`pending_proposal.intent_text` in `ui_draft`:** required verbatim for
   the header origin line and stale-line Re-propose — confirm it is
   included.

Nice-to-have (not blocking): `ui_mark {thread_id, read?, archived?}` to
batch the two `label` calls the UI makes today.
