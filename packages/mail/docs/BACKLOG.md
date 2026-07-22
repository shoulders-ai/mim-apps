# Mail — Ruled but not yet shipped

Panel-mandated fixes (see DESIGN.md) that need their own efforts. Ordered by
severity as judged by the persona workshop.

**Editor integrity**
- Undo preservation: keep the write-layout textarea alive across proposal
  arrival; patch review-layout textarea values in place instead of
  innerHTML-wiping (native ⌘Z currently dies on rebuilds).
- Review-layout structural editing: Backspace at block offset 0 merges
  blocks (demote affected hunks, caret at seam); typing a blank line
  re-splits — today cross-block edits are silently impossible.
- Tab escapes the hunk cycle: Tab from the last live hunk falls through to
  the Ask-AI footer instead of wrapping (needs an at-last-hunk API on
  studio/voices surfaces).
- Studio scope leak: `data-region="studio"` on the studio root; e/c/j/k
  dead over studio chrome; Subject Enter → editor end.

**Proposal lifecycle**
- Supersede/adoption correctness: adopt differing server proposals, clear
  `s.proposal` when the last pending hunk resolves, mark superseded hunks
  visibly ("3 earlier suggestions replaced").
- Chat-proposal discoverability: `has_pending_proposal` on ui_inbox draft
  rows → `proposed` chip + Drafts-tab accent dot; status-line jump action
  when a proposal lands on a non-open draft; ~5s idle-studio poll.
- Empty-draft agent propose: `mail.draft.propose` gains the empty-body →
  initial-draft branch (origin chat_agent) so the agent fills an open empty
  draft instead of forking a duplicate.

**Send gate**
- Exact-message preview in the confirm card built by the same assembly
  function `draft_send` uses (extract it so preview and send cannot
  diverge); attachment-absence note.
- Send receipt with count + View action ("Sent to Anna +2 · View").
- Recipients snapshotted from the approved revision, not live draft state.

**Reading**
- Attachment chips (filename · size, Gmail deep link) on expanded messages;
  inline "Open in Gmail ↗" on messages whose source was HTML.

**Privacy & voices**
- Settings: Suggestions on/off (honored by refreshStudioProposal + the
  flywheel), exemplar/domain-fallback toggle with an "AI saw: …" context
  line at the proposal origin, "Disconnect and delete local data" two-step.
- First voice seed gated behind one explicit consent sentence with the
  message count consumed; "What the AI sees" disclosure link in onboarding.
- Voice management: New voice… / Duplicate (needs a backend voice_create
  surface), last-used voice default on new drafts, ⌘⇧V picker, ArrowUp
  intent recall in Ask-AI, spinner row while voices load.
- Voices keyboard contract: Esc/u exit to inbox with focus restored;
  ArrowLeft/Right cycle the voice tablist. Metric title definitions
  ("Sent without edits" rename).

**Misc**
- ⇧D dismiss-all from a strip (mirroring ⇧A).
- Inbox tab unread count in the command bar (needs a cheap unread-count
  data source).
- UX-SPEC §1–§3 re-ratification to match DESIGN.md in one documented pass.
