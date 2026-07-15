// The editor: a pure paragraph engine (splitParagraphs + caret offset
// mapping — node-testable, no DOM) and the two-layout DOM editor
// (UX-SPEC §3.4.1): one auto-growing textarea in write layout, a stack of
// per-paragraph textareas with highlight-pair backdrops in review layout.

import { escapeHtml } from './utils.js'

// ── Pure paragraph engine ────────────────────────────────────────────────

// Split on /\n{2,}/ keeping separators so join is lossless.
// Returns [{ text, start, end, sep }] with body character offsets.
export function splitParagraphs(body) {
  const text = String(body ?? '')
  const paras = []
  const re = /\n{2,}/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    paras.push({ text: text.slice(last, m.index), start: last, end: m.index, sep: m[0] })
    last = m.index + m[0].length
  }
  paras.push({ text: text.slice(last), start: last, end: text.length, sep: '' })
  return paras
}

export function joinParagraphs(paras) {
  return paras.map(p => p.text + p.sep).join('')
}

// Body offset -> { index, local } paragraph-local caret position.
// Offsets that land inside a separator clamp to the end of the paragraph
// before it.
export function toLocal(paras, offset) {
  const max = paras[paras.length - 1].end
  const off = Math.max(0, Math.min(Number(offset) || 0, max))
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i]
    if (off <= p.end) return { index: i, local: Math.max(0, off - p.start) }
    if (off < p.end + p.sep.length) return { index: i, local: p.text.length }
  }
  const i = paras.length - 1
  return { index: i, local: paras[i].text.length }
}

// { index, local } -> body offset.
export function toBody(paras, index, local) {
  const i = Math.max(0, Math.min(Number(index) || 0, paras.length - 1))
  const p = paras[i]
  return p.start + Math.max(0, Math.min(Number(local) || 0, p.text.length))
}

// Paragraph index (0-based) containing a body offset.
export function paragraphAt(paras, offset) {
  return toLocal(paras, offset).index
}

// ── DOM editor ───────────────────────────────────────────────────────────
//
// mountEditor(host, handlers) -> controller
// handlers: {
//   onInput(body)        after each local edit (caller debounces the ledger)
//   onDemote(blockIndex) synchronously on first keystroke in a block with
//                        pending hunks (caller updates demoted + re-calls
//                        applyDemotion before the input lands)
//   onHunkClick(hunkId)  click on a tinted span
//   onScope(paraIndex1)  ¶ gutter click (1-based)
//   onBlur()             textarea blur (flush)
// }
// Content flows in via setContent({ body, vms, activeId, demoted,
// stripHtml, focus }) — vms from hunks.locateHunks, stripHtml renders the
// active strip. The controller never talks to tools.

export function mountEditor(host, handlers = {}) {
  let body = ''
  let blocks = []            // review layout: [{ text, sep }]
  let layout = null          // 'write' | 'review'
  let vms = []
  let vmBlocks = new Map()   // vmId -> block index (assigned at rebuild)
  let activeId = null
  let demoted = new Set()
  let stripHtml = () => ''
  let scoped = null          // 1-based scoped paragraph (¶ chip pinned)
  let hoverPara = null
  let mirrorDirty = true
  let marksSig = ''
  let raf = 0

  const root = document.createElement('div')
  root.className = 'ed'
  host.appendChild(root)

  const inner = document.createElement('div')
  inner.className = 'ed-inner'
  root.appendChild(inner)

  const hoverChip = makeChip('Ask AI about this paragraph')
  const scopedChip = makeChip('Scoped for Ask AI')
  scopedChip.classList.add('scoped')
  root.appendChild(hoverChip)
  root.appendChild(scopedChip)

  const mirror = document.createElement('div')
  mirror.className = 'ed-mirror'
  mirror.setAttribute('aria-hidden', 'true')
  root.appendChild(mirror)

  root.addEventListener('mousemove', onRootMove)
  root.addEventListener('mouseleave', () => { hoverPara = null; hoverChip.hidden = true })

  // Pane resizes change wrap widths — re-flow the auto-grown textareas.
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
        inner.querySelectorAll('.ed-ta').forEach(autoGrow)
        mirrorDirty = true
      })
    : null
  ro?.observe(root)

  function makeChip(title) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-pmark'
    b.title = title
    b.textContent = '¶'
    b.hidden = true
    b.tabIndex = -1 // keyboard path is the ¶N prefix in the Ask-AI input
    b.setAttribute('aria-hidden', 'true')
    b.addEventListener('mousedown', e => e.preventDefault())
    b.addEventListener('click', () => {
      const idx = b === scopedChip ? (scoped != null ? scoped - 1 : null) : hoverPara
      if (idx != null) handlers.onScope?.(idx + 1)
    })
    return b
  }

  // ── block bookkeeping ──

  function blockStart(i) {
    let off = 0
    for (let j = 0; j < i; j++) off += blocks[j].text.length + blocks[j].sep.length
    return off
  }

  function rebuildBody() {
    body = blocks.map(b => b.text + b.sep).join('')
  }

  function desiredLayout(list) {
    return list.length > 0 ? 'review' : 'write'
  }

  // ── DOM builders ──

  function makeTa(value, blockIdx) {
    const ta = document.createElement('textarea')
    ta.className = 'ed-ta'
    ta.rows = 1
    ta.value = value
    ta.spellcheck = true
    ta.dataset.region = 'editor'
    if (blockIdx != null) ta.dataset.block = String(blockIdx)
    ta.setAttribute('aria-label', blockIdx == null ? 'Email body' : `Email body, paragraph ${blockIdx + 1}`)
    ta.setAttribute('aria-describedby', 'edTabHint')
    ta.addEventListener('beforeinput', onBeforeInput)
    ta.addEventListener('input', onTaInput)
    ta.addEventListener('blur', () => handlers.onBlur?.())
    ta.addEventListener('mouseup', onTaClick)
    return ta
  }

  function autoGrow(ta) {
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }

  function blockEls() {
    return Array.from(inner.querySelectorAll('.ed-block'))
  }

  function vmsInBlock(i) {
    return vms.filter(v => vmBlocks.get(v.id) === i)
  }

  function backdropHtmlFor(i) {
    const text = blocks[i].text
    const start = blockStart(i)
    const marks = []
    for (const vm of vmsInBlock(i)) {
      let s
      let e
      if (demoted.has(vm.id)) {
        // Block text may have changed under a demoted hunk — re-match.
        const at = text.indexOf(vm.original_text)
        if (at === -1) continue
        s = at
        e = at + vm.original_text.length
      } else {
        s = vm.start - start
        e = vm.end - start
        if (s < 0 || e > text.length) continue
      }
      const cls = demoted.has(vm.id)
        ? 'demoted'
        : `${vm.kind}${vm.id === activeId ? ' hot' : ''}${vm.kind === 'rem' && vm.id === activeId ? ' strike' : ''}`
      marks.push({ start: s, end: e, cls })
    }
    marks.sort((a, b) => a.start - b.start)
    let html = ''
    let at = 0
    for (const m of marks) {
      if (m.start < at) continue
      html += escapeHtml(text.slice(at, m.start))
      html += `<mark class="${m.cls}">${escapeHtml(text.slice(m.start, m.end))}</mark>`
      at = m.end
    }
    html += escapeHtml(text.slice(at))
    if (text.endsWith('\n') || text === '') html += '​'
    return html
  }

  function renderBlockBackdrop(i) {
    const el = blockEls()[i]
    if (!el) return
    const back = el.querySelector('.hl-back')
    if (back) back.innerHTML = backdropHtmlFor(i)
  }

  function stripEl() {
    return inner.querySelector('.ed-strip-slot')
  }

  function removeStrip(animate) {
    const slot = stripEl()
    if (!slot) return
    if (animate && slot.animate) {
      const h = slot.offsetHeight
      const anim = slot.animate([{ height: `${h}px`, opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 120, easing: 'ease-out' })
      anim.onfinish = () => slot.remove()
      slot.style.overflow = 'hidden'
    } else {
      slot.remove()
    }
  }

  function placeStrip(focus) {
    removeStrip(false)
    if (!activeId) return
    const vm = vms.find(v => v.id === activeId)
    if (!vm) return
    const i = vmBlocks.get(vm.id)
    const el = blockEls()[i]
    if (!el) return
    const slot = document.createElement('div')
    slot.className = 'ed-strip-slot'
    slot.innerHTML = stripHtml(vm)
    el.after(slot)
    const strip = slot.querySelector('.strip')
    if (slot.animate && strip) {
      const h = slot.offsetHeight
      slot.style.overflow = 'hidden'
      const anim = slot.animate([{ height: '0px', opacity: 0 }, { height: `${h}px`, opacity: 1 }], { duration: 120, easing: 'ease-out' })
      anim.onfinish = () => { slot.style.overflow = '' }
    }
    if (focus && strip) {
      strip.focus()
      strip.scrollIntoView({ block: 'center', behavior: 'auto' })
    }
  }

  // Non-structural updates: keep the slot in place, refresh its content
  // only when it changed, and never drop focus on the floor.
  function placeStripIfNeeded() {
    const slot = stripEl()
    const currentId = slot?.querySelector('.strip')?.dataset.hunk
    if (!activeId) {
      if (slot) removeStrip(false)
      return
    }
    if (currentId !== activeId) {
      placeStrip(false)
      return
    }
    const vm = vms.find(v => v.id === activeId)
    if (!vm) return
    const i = vmBlocks.get(vm.id)
    const block = blockEls()[i]
    if (block && block.nextElementSibling !== slot) block.after(slot)
    const html = stripHtml(vm)
    if (slot.dataset.rendered === html) return
    const hadStripFocus = slot.contains(document.activeElement)
      && document.activeElement.classList?.contains('strip')
    slot.innerHTML = html
    slot.dataset.rendered = html
    if (hadStripFocus) slot.querySelector('.strip')?.focus()
  }

  function rebuild(focusPlan) {
    const caret = focusPlan?.offset != null
      ? { offset: focusPlan.offset }
      : (root.contains(document.activeElement) && document.activeElement.classList?.contains('ed-ta'))
        ? { offset: caretBodyOffset() }
        : null
    // A server reconcile can rebuild while a strip holds focus — keep it.
    const hadStripFocus = root.contains(document.activeElement)
      && document.activeElement.classList?.contains('strip')

    inner.innerHTML = ''
    mirrorDirty = true

    if (layout === 'write') {
      const ta = makeTa(body, null)
      const block = document.createElement('div')
      block.className = 'ed-block'
      block.dataset.block = '0'
      block.appendChild(ta)
      inner.appendChild(block)
      autoGrow(ta)
    } else {
      blocks.forEach((b, i) => {
        const block = document.createElement('div')
        block.className = 'ed-block'
        block.dataset.block = String(i)
        const hasMarks = vmsInBlock(i).length > 0
        if (hasMarks) {
          const pair = document.createElement('div')
          pair.className = 'hl-pair'
          const back = document.createElement('div')
          back.className = 'hl-back'
          back.setAttribute('aria-hidden', 'true')
          back.innerHTML = backdropHtmlFor(i)
          const ta = makeTa(b.text, i)
          ta.classList.add('ed-ta-clear')
          pair.appendChild(back)
          pair.appendChild(ta)
          block.appendChild(pair)
        } else {
          block.appendChild(makeTa(b.text, i))
        }
        inner.appendChild(block)
      })
      inner.querySelectorAll('.ed-ta').forEach(autoGrow)
      placeStrip(false)
    }

    if (caret && focusPlan?.blur !== true) {
      focusBodyOffset(caret.offset)
    } else if (hadStripFocus) {
      stripEl()?.querySelector('.strip')?.focus()
    }
    updateScopedChip()
  }

  // ── events ──

  function onBeforeInput(e) {
    if (layout !== 'review') return
    const i = Number(e.target.dataset.block)
    const pendingHere = vmsInBlock(i).filter(v => !demoted.has(v.id))
    // Pass the exact vm ids — the caller's paragraph indices may drift from
    // DOM blocks while the ledger write is in flight.
    if (pendingHere.length > 0) handlers.onDemote?.(i, pendingHere.map(v => v.id))
  }

  function onTaInput(e) {
    const ta = e.target
    autoGrow(ta)
    mirrorDirty = true
    if (layout === 'write') {
      body = ta.value
    } else {
      const i = Number(ta.dataset.block)
      blocks[i].text = ta.value
      rebuildBody()
      renderBlockBackdrop(i)
    }
    handlers.onInput?.(body)
  }

  function onTaClick(e) {
    if (layout !== 'review') return
    const ta = e.target
    const i = Number(ta.dataset.block)
    const local = ta.selectionStart
    if (ta.selectionStart !== ta.selectionEnd) return
    const start = blockStart(i)
    const off = start + local
    const hit = vms.find(v => !demoted.has(v.id) && off >= v.start && off <= v.end && vmBlocks.get(v.id) === i)
    if (hit && hit.id !== activeId) handlers.onHunkClick?.(hit.id)
  }

  function onRootMove(e) {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      const rects = paragraphRects()
      const rootRect = root.getBoundingClientRect()
      const y = e.clientY - rootRect.top
      const hit = rects.find(r => y >= r.top && y < r.top + r.height)
      if (!hit) { hoverPara = null; hoverChip.hidden = true; return }
      if (scoped != null && hit.index === scoped - 1) { hoverChip.hidden = true; hoverPara = hit.index; return }
      hoverPara = hit.index
      hoverChip.style.top = `${hit.top + 2}px`
      hoverChip.hidden = false
    })
  }

  function ensureMirror() {
    if (!mirrorDirty) return
    const ta = inner.querySelector('.ed-ta')
    if (!ta) return
    mirror.style.width = `${ta.clientWidth}px`
    const paras = splitParagraphs(body)
    mirror.innerHTML = paras
      .map((p, i) => `<span data-p="${i}">${escapeHtml(p.text) || '​'}</span>${escapeHtml(p.sep)}`)
      .join('')
    mirrorDirty = false
  }

  function paragraphRects() {
    if (layout === 'review') {
      return blockEls().map((el, i) => ({ index: i, top: el.offsetTop, height: el.offsetHeight }))
    }
    ensureMirror()
    const ta = inner.querySelector('.ed-ta')
    const base = ta ? ta.offsetTop : 0
    return Array.from(mirror.querySelectorAll('span[data-p]')).map(span => ({
      index: Number(span.dataset.p),
      top: base + span.offsetTop,
      height: span.offsetHeight,
    }))
  }

  function updateScopedChip() {
    if (scoped == null) { scopedChip.hidden = true; return }
    const rects = paragraphRects()
    const r = rects.find(x => x.index === scoped - 1)
    if (!r) { scopedChip.hidden = true; return }
    scopedChip.style.top = `${r.top + 2}px`
    scopedChip.hidden = false
  }

  // ── caret helpers ──

  function caretBodyOffset() {
    const ae = document.activeElement
    if (!ae || !root.contains(ae) || !ae.classList?.contains('ed-ta')) return null
    if (layout === 'write') return ae.selectionStart
    const i = Number(ae.dataset.block)
    return blockStart(i) + ae.selectionStart
  }

  function focusBodyOffset(offset) {
    const off = Math.max(0, Math.min(Number(offset) || 0, body.length))
    if (layout === 'write') {
      const ta = inner.querySelector('.ed-ta')
      if (!ta) return
      ta.focus()
      try { ta.setSelectionRange(off, off) } catch {}
      return
    }
    let i = 0
    while (i < blocks.length - 1 && off > blockStart(i) + blocks[i].text.length) i++
    const local = Math.max(0, Math.min(off - blockStart(i), blocks[i].text.length))
    const ta = blockEls()[i]?.querySelector('.ed-ta')
    if (!ta) return
    ta.focus()
    try { ta.setSelectionRange(local, local) } catch {}
  }

  // ── public API ──

  const api = {
    root,

    setContent(next) {
      const nextBody = String(next.body ?? '')
      vms = next.vms || []
      activeId = next.activeId ?? null
      demoted = next.demoted || new Set()
      if (next.stripHtml) stripHtml = next.stripHtml
      const nextLayout = desiredLayout(vms)

      let structural = nextLayout !== layout || nextBody !== body
      layout = nextLayout
      body = nextBody
      if (structural) {
        // Only rebuild the block model on structural changes — user typing
        // may have introduced blank lines inside a DOM block, and the DOM
        // is the source of truth until the next body change.
        blocks = layout === 'review'
          ? splitParagraphs(body).map(p => ({ text: p.text, sep: p.sep }))
          : [{ text: body, sep: '' }]
      }

      // Assign each vm to its block.
      vmBlocks = new Map()
      if (layout === 'review') {
        for (const vm of vms) {
          let i = 0
          while (i < blocks.length - 1 && vm.start >= blockStart(i) + blocks[i].text.length + blocks[i].sep.length) i++
          vmBlocks.set(vm.id, i)
        }
      }

      // A block gaining/losing marks needs its highlight pair (re)built.
      const sig = vms.map(v => `${v.id}@${vmBlocks.get(v.id)}`).join('|')
      if (!structural && layout === 'review' && sig !== marksSig) structural = true
      marksSig = sig

      if (structural) {
        rebuild(next.focus)
      } else {
        blockEls().forEach((_, i) => renderBlockBackdrop(i))
        placeStripIfNeeded()
        updateScopedChip()
      }
      if (next.focus?.strip && activeId) {
        const strip = stripEl()?.querySelector('.strip')
        if (strip) {
          strip.focus()
          strip.scrollIntoView({ block: 'center', behavior: 'auto' })
        }
      } else if (next.focus?.offset != null && !next.focus?.strip) {
        focusBodyOffset(next.focus.offset)
      } else if (next.focus?.end) {
        focusBodyOffset(body.length)
      }
    },

    getBody() {
      return body
    },

    // Synchronous demotion (§3.4.2): re-tint to chrome-mid + drop the strip
    // before the keystroke lands. No textarea rebuild — caret is untouched.
    applyDemotion(nextDemoted) {
      demoted = nextDemoted
      if (activeId && demoted.has(activeId)) {
        activeId = null
        removeStrip(false)
      }
      blockEls().forEach((_, i) => renderBlockBackdrop(i))
    },

    setActive(id, { focus = true } = {}) {
      activeId = id
      blockEls().forEach((_, i) => renderBlockBackdrop(i))
      if (!id) { removeStrip(true); return }
      placeStrip(focus)
    },

    refreshStrip({ focusSel = null } = {}) {
      const slot = stripEl()
      if (!slot || !activeId) return
      const vm = vms.find(v => v.id === activeId)
      if (!vm) return
      slot.innerHTML = stripHtml(vm)
      if (focusSel) slot.querySelector(focusSel)?.focus()
    },

    focusStrip() {
      const strip = stripEl()?.querySelector('.strip')
      if (strip) strip.focus()
    },

    activeStripElement() {
      return stripEl()?.querySelector('.strip') || null
    },

    caretBodyOffset,
    focusBodyOffset,
    focusEnd() { focusBodyOffset(body.length) },

    hasFocus() {
      return root.contains(document.activeElement)
    },

    setScoped(n) {
      scoped = n
      updateScopedChip()
    },

    wash() {
      inner.classList.remove('ed-wash')
      void inner.offsetWidth
      inner.classList.add('ed-wash')
      setTimeout(() => inner.classList.remove('ed-wash'), 450)
    },

    destroy() {
      if (raf) cancelAnimationFrame(raf)
      ro?.disconnect()
      root.remove()
    },
  }

  return api
}
