import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Highlight, MarkColor, MarksData, PaneView, ReplyMarks, Sketch } from '../types'
import { sketchSvg } from './ink'
import { assign, blockHas, firstLine, layout, overlapping } from './marks'
import type { Segment } from './marks'
import { notebookHtml, notebookMarkdown } from './notebook'

const STORE_KEY = 'margin-v1'
const UI_KEY = 'margin-ui'
const PANE = 'margin'
const EMPTY: MarksData = { highlights: {}, markers: [], sketches: [] }

const data = atom({ plugin: 'margin', key: 'data' } as const, EMPTY, { shape: 'margin-1' })
const noting = atom({ plugin: 'margin', key: 'noting' } as const, null)
const flash = atom({ plugin: 'margin', key: 'flash' } as const, null)
const view = atom({ plugin: 'margin', key: 'view' } as const, 'notebook')
const focus = atom({ plugin: 'margin', key: 'focus' } as const, null)
const showAll = atom({ plugin: 'margin', key: 'showAll' } as const, false)
const hidden = atom({ plugin: 'margin', key: 'hidden' } as const, false)
const query = atom({ plugin: 'margin', key: 'query' } as const, '')
const filter = atom({ plugin: 'margin', key: 'filter' } as const, 'all')
const canUndo = atom({ plugin: 'margin', key: 'canUndo' } as const, false)
// One member per reply: a change redraws that reply alone, so pressing a
// button never makes the whole conversation draw again.
const REPLY = { plugin: 'margin', key: 'reply' } as const

type Look = { label: string; key: string; bg?: string; fg?: string; underline?: true; strike?: true }
const COLORS: Record<MarkColor, Look> = {
  yellow: { label: 'Yellow', key: '1', bg: '#fde68a', fg: '#1c1917' },
  green: { label: 'Green', key: '2', bg: '#bbf7d0', fg: '#1c1917' },
  pink: { label: 'Pink', key: '3', bg: '#fbcfe8', fg: '#1c1917' },
  blue: { label: 'Blue', key: '4', bg: '#bfdbfe', fg: '#1c1917' },
  orange: { label: 'Orange', key: '5', bg: '#fed7aa', fg: '#1c1917' },
  underline: { label: 'Underline', key: '6', underline: true },
  strike: { label: 'Strike', key: '7', strike: true },
}
const COLOR_NAMES = Object.keys(COLORS) as MarkColor[]
const MARKER_COLOR = '#d97706'
const HINT = 'Select text in a reply, then pick a colour. Erase takes it off. Quote asks Claude about it. /margin hide folds this row away.'

/** Text props that draw a mark: a pastel background, or a pen line. */
function lookOf(c: MarkColor | undefined) {
  if (!c) return {}
  const l = COLORS[c]
  if (l.underline) return { underline: true, color: '#2563eb' }
  if (l.strike) return { strikethrough: true, dimColor: true }
  return { backgroundColor: l.bg, color: l.fg }
}

function segmentProps(s: Segment) {
  return {
    ...lookOf(s.color),
    ...(s.bold || s.head ? { weight: 'semibold' as const } : {}),
    ...(s.italic ? { italic: true } : {}),
    ...(s.code ? { mono: true } : {}),
    ...(s.head ? { size: 'heading' as const } : {}),
  }
}

// What this run of the module has seen drawn: reply blocks in order. Rebuilt
// as the transcript draws after a reload.
const texts = new Map<string, string>()
const order: string[] = []
const replyStarts = new Set<string>()
const visible = new Set<string>()
const here = { session: '', where: '', dir: '', isWindows: false, isMac: false }
const undoStack: MarksData[] = []
let sketchingId: string | null = null
// The person's settings (userConfig in plugin.json), read at each load.
const cfg = { folder: '', startHidden: false, compact: false, writeFiles: true, autoMark: false }

const seen = () => order.filter(id => texts.has(id)).map(id => ({ id, md: texts.get(id)! }))
const markerHere = (d: MarksData) => d.markers.find(m => texts.has(m))
const short = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}
const isMine = (x: { session?: string; requestId?: string }) =>
  (x.session !== undefined && x.session === here.session) || (x.requestId !== undefined && texts.has(x.requestId))
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** Replies drawn after the marker, counted by reply (not by text block). */
function newSince(m: string): number {
  const at = order.indexOf(m)
  if (at < 0) return 0
  const after = order.slice(at + 1)
  const starts = after.filter(id => replyStarts.has(id)).length
  return starts || (after.length ? 1 : 0)
}

function normalize(v: unknown): MarksData | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Partial<MarksData>
  if (!o.highlights || typeof o.highlights !== 'object') return undefined
  return {
    highlights: o.highlights,
    markers: Array.isArray(o.markers) ? o.markers : [],
    sketches: Array.isArray(o.sketches) ? o.sketches : [],
  }
}

function marksFor(d: MarksData, id: string): ReplyMarks {
  return {
    highlights: d.highlights[id] ?? [],
    isMarked: d.markers.includes(id),
    sketches: d.sketches.filter(s => s.requestId === id),
    isSketching: sketchingId === id,
  }
}

/** Writes the reply members whose marks differ between two versions. */
async function syncReplies($: EngineInterface, before: MarksData | null, after: MarksData, also: string[] = []) {
  const ids = new Set<string>(also)
  for (const k of new Set([...Object.keys(after.highlights), ...Object.keys(before?.highlights ?? {})])) {
    if (JSON.stringify(after.highlights[k] ?? []) !== JSON.stringify(before?.highlights[k] ?? [])) ids.add(k)
  }
  const was = new Set(before?.markers ?? [])
  const now = new Set(after.markers)
  for (const m of now) if (!was.has(m)) ids.add(m)
  for (const m of was) if (!now.has(m)) ids.add(m)
  const sk = (d: MarksData | null) => new Map((d?.sketches ?? []).map(s => [s.id, s.requestId]))
  const a = sk(before)
  const b = sk(after)
  for (const [id, rid] of b) if (!a.has(id) && rid) ids.add(rid)
  for (const [id, rid] of a) if (!b.has(id) && rid) ids.add(rid)
  for (const id of ids) await $.state.set({ ...REPLY, id }, marksFor(after, id))
}

async function writeNotebook($: EngineInterface, d: MarksData) {
  if (!here.dir || !cfg.writeFiles) return
  try {
    await $.fs.write(`${here.dir}/index.html`, notebookHtml(d))
    await $.fs.write(`${here.dir}/notebook.md`, notebookMarkdown(d))
    for (const s of d.sketches) await $.fs.write(`${here.dir}/sketches/${s.id}.svg`, sketchSvg(s, { paper: '#ffffff' }))
  } catch (err) {
    await update($, flash, () => `Couldn't write the notebook folder: ${String(err).slice(0, 120)}`)
  }
}

async function persist($: EngineInterface, d: MarksData) {
  await $.store.set(STORE_KEY, d)
  await writeNotebook($, d)
}

async function save($: EngineInterface, change: (d: MarksData) => MarksData) {
  const before = await read($, data)
  const after = await update($, data, change)
  undoStack.push(before)
  if (undoStack.length > 30) undoStack.shift()
  await update($, canUndo, () => true)
  await syncReplies($, before, after)
  await persist($, after)
  return after
}

async function undo($: EngineInterface) {
  const prev = undoStack.pop()
  if (!prev) return say($, 'Nothing to undo.')
  const before = await read($, data)
  await update($, data, () => prev)
  await update($, canUndo, () => undoStack.length > 0)
  await syncReplies($, before, prev)
  await persist($, prev)
  await update($, noting, () => null)
  await say($, 'Undone.')
}

async function say($: EngineInterface, text: string | null) {
  await update($, flash, () => text)
}

async function openPane($: EngineInterface, v: PaneView) {
  await update($, view, () => v)
  await $.ui.open({ id: PANE, title: 'Margin' })
}

async function targetsOf($: EngineInterface) {
  const sel = await $.ui.selection()
  const text = sel?.text.trim() ?? ''
  if (!text) return { text, targets: [] as { id: string; text: string }[] }
  if (sel?.requestId && texts.has(sel.requestId) && blockHas(texts.get(sel.requestId)!, text)) {
    return { text, targets: [{ id: sel.requestId, text }] }
  }
  return { text, targets: assign(text, seen()) }
}

/** The reply a button means: the one the selection is in, else the lowest on screen, else the latest. */
async function replyInFocus($: EngineInterface): Promise<{ id: string | undefined; fromSelection: boolean }> {
  const sel = await $.ui.selection()
  if (sel?.requestId && texts.has(sel.requestId)) return { id: sel.requestId, fromSelection: true }
  if (sel?.text.trim()) {
    const hit = assign(sel.text, seen()).pop()?.id
    if (hit) return { id: hit, fromSelection: true }
  }
  return { id: order.filter(id => visible.has(id)).pop() ?? order[order.length - 1], fromSelection: false }
}

async function highlight($: EngineInterface, color: MarkColor) {
  const { text, targets } = await targetsOf($)
  if (!text) return say($, 'Select some text in a reply first, then pick a colour.')
  if (targets.length === 0) return say($, "Couldn't place that selection in a reply. Try selecting inside one reply.")

  const now = await $.clock.now()
  let lastId: string | null = null
  let removed = 0
  await save($, d => {
    const highlights = { ...d.highlights }
    targets.forEach((t, i) => {
      const list = highlights[t.id] ?? []
      const same = list.find(x => x.text === t.text && x.color === color)
      if (same) {
        // Same text, same look again: take it off.
        highlights[t.id] = list.filter(x => x !== same)
        removed++
        return
      }
      const old = list.find(x => x.text === t.text)
      const hl: Highlight = {
        id: `${now.toString(36)}-${i}`,
        requestId: t.id,
        text: t.text,
        color,
        at: now,
        session: here.session,
        where: here.where,
        context: firstLine(texts.get(t.id) ?? '', 90),
        ...(old?.note ? { note: old.note } : {}),
      }
      highlights[t.id] = [...list.filter(x => x.text !== t.text), hl]
      lastId = hl.id
    })
    for (const k of Object.keys(highlights)) if (highlights[k]!.length === 0) delete highlights[k]
    return { ...d, highlights }
  })
  await update($, noting, () => lastId)
  await say($, lastId ? 'Marked. Add a note below, or just keep reading.' : removed ? 'Highlight removed.' : null)
}

async function erase($: EngineInterface) {
  const { text, targets } = await targetsOf($)
  if (!text) return say($, 'Select the highlighted text you want to clear, then press Erase.')
  let gone = 0
  const d0 = await read($, data)
  for (const t of targets) gone += overlapping(texts.get(t.id) ?? '', d0.highlights[t.id] ?? [], t.text).length
  if (gone === 0) return say($, 'No highlight in that selection.')
  await save($, d => {
    const highlights = { ...d.highlights }
    for (const t of targets) {
      const list = highlights[t.id] ?? []
      const hit = new Set(overlapping(texts.get(t.id) ?? '', list, t.text).map(x => x.id))
      const left = list.filter(x => !hit.has(x.id))
      if (left.length) highlights[t.id] = left
      else delete highlights[t.id]
    }
    return { ...d, highlights }
  })
  await update($, noting, () => null)
  await say($, `Removed ${plural(gone, 'highlight')}. Undo brings ${gone > 1 ? 'them' : 'it'} back.`)
}

async function setMarker($: EngineInterface, target: string) {
  const mine = new Set(order)
  await save($, d => ({ ...d, markers: [target, ...d.markers.filter(m => !mine.has(m))].slice(0, 300) }))
}

async function markHere($: EngineInterface) {
  const { id, fromSelection } = await replyInFocus($)
  if (!id) return say($, 'No reply to mark yet.')
  await setMarker($, id)
  await say($, fromSelection ? 'Marked where you stopped.' : 'Marked the latest reply. Select text in a reply first to mark that one.')
}

async function clearMark($: EngineInterface) {
  const mine = new Set(order)
  await save($, d => ({ ...d, markers: d.markers.filter(m => !mine.has(m)) }))
  await say($, 'Marker cleared.')
}

async function resume($: EngineInterface) {
  const m = markerHere(await read($, data))
  if (!m) return say($, 'No marker in this session yet.')
  let moved = false
  try {
    moved = !(await $.ui.scroll({ to: { requestId: m }, block: 'center' })).deny
  } catch {
    moved = false
  }
  // The desktop app doesn't let a mod scroll its transcript: show the rest
  // of the reading in the pane instead.
  if (!moved) await openPane($, 'resume')
}

async function removeHighlight($: EngineInterface, hl: Highlight) {
  await save($, d => {
    const highlights = { ...d.highlights }
    const list = (highlights[hl.requestId] ?? []).filter(x => x.id !== hl.id)
    if (list.length) highlights[hl.requestId] = list
    else delete highlights[hl.requestId]
    return { ...d, highlights }
  })
  await say($, 'Highlight removed. Undo brings it back.')
}

async function setNote($: EngineInterface, id: string, note: string) {
  await save($, d => {
    const highlights: MarksData['highlights'] = {}
    for (const [k, list] of Object.entries(d.highlights)) {
      highlights[k] = list.map(x => {
        if (x.id !== id) return x
        const { note: _old, ...rest } = x
        return note.trim() ? { ...rest, note: note.trim() } : rest
      })
    }
    return { ...d, highlights }
  })
  await update($, noting, () => null)
  await say($, note.trim() ? 'Note saved.' : null)
}

async function setSketching($: EngineInterface, id: string | null) {
  const was = sketchingId
  sketchingId = id
  const d = await read($, data)
  for (const r of new Set([was, id])) if (r) await $.state.set({ ...REPLY, id: r }, marksFor(d, r))
}

async function startSketch($: EngineInterface) {
  const { id } = await replyInFocus($)
  if (!id) return say($, 'No reply to sketch under yet.')
  if (sketchingId === id) {
    await setSketching($, null)
    return say($, 'Sketch pad closed.')
  }
  await setSketching($, id)
  await say($, 'Sketch pad open under the reply. Drag to draw, then Save.')
}

async function removeSketch($: EngineInterface, id: string) {
  await save($, d => ({ ...d, sketches: d.sketches.filter(x => x.id !== id) }))
  await say($, 'Sketch removed. Undo brings it back.')
}

async function openFile($: EngineInterface, path: string) {
  const argv = here.isWindows ? ['explorer.exe', path.replace(/\//g, '\\')] : [here.isMac ? 'open' : 'xdg-open', path]
  try {
    await $.process.run(argv, { timeoutMs: 5000 })
  } catch {
    await say($, `Open it yourself: ${path}`)
  }
}

async function setHidden($: EngineInterface, v: boolean) {
  await update($, hidden, () => v)
  await $.store.set(UI_KEY, { hidden: v })
}

async function quote($: EngineInterface) {
  const sel = await $.ui.selection()
  const text = sel?.text.trim() ?? ''
  if (!text) return say($, 'Select text in a reply, then press Quote to ask Claude about it.')
  const quoted = text.replace(/^/gm, '> ')
  const r = await $.prompt.fill({ text: `${quoted}\n\n`, mode: 'insert' })
  await say($, r.isFilled ? 'Quoted into your prompt. Type your question under it.' : "Couldn't reach the prompt box.")
}

function asMarkdown(list: readonly Highlight[]): string {
  return list.map(x => `> ${x.text.replace(/\n/g, '\n> ')}` + (x.note ? `\n\n${x.note}` : '')).join('\n\n---\n\n')
}

async function copyAll($: EngineInterface, list: readonly Highlight[]) {
  if (list.length === 0) return say($, 'Nothing to copy yet.')
  const r = await $.ui.copy({ text: asMarkdown(list) })
  await say($, r.isCopied ? `Copied ${plural(list.length, 'highlight')} as Markdown.` : "Couldn't copy here. Open the notebook in your browser instead.")
}

export const register: Register = (on, options) => {
  cfg.folder = typeof options.notebookFolder === 'string' ? options.notebookFolder.trim() : ''
  cfg.startHidden = options.startHidden === true
  cfg.compact = options.rowStyle === 'compact'
  cfg.writeFiles = options.saveNotebook !== false
  cfg.autoMark = options.autoMark === true

  on('session.start', async ($, e, next) => {
    const stored = normalize(await $.store.get(STORE_KEY))
    if (stored) {
      await update($, data, () => stored)
      await syncReplies($, null, stored)
    }
    here.session = await $.session.id()
    here.where = e.cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'Claude Code'
    const profile = await $.env.get('USERPROFILE')
    const home = profile ?? (await $.env.get('HOME')) ?? ''
    here.isWindows = profile !== undefined
    here.isMac = !here.isWindows && home.startsWith('/Users/')
    const fallback = home ? `${home.replace(/\\/g, '/')}/Documents/Margin Notebook` : ''
    here.dir = cfg.folder ? cfg.folder.replace(/\\/g, '/') : fallback
    const ui = (await $.store.get(UI_KEY)) as { hidden?: boolean } | undefined
    await update($, hidden, () => (typeof ui?.hidden === 'boolean' ? ui.hidden : cfg.startHidden))
    await $.command.register({
      name: 'margin',
      description: 'Margin: open the notebook, or hide/show the row above the prompt',
      argumentHint: '[hide | show | sketch | resume | undo]',
    })
    return next(e)
  })

  // With auto-mark on, sending a message marks the latest reply as read.
  on('prompt.submit', async ($, e, next) => {
    if (cfg.autoMark && !e.command && !e.isMeta) {
      const last = order[order.length - 1]
      const d = await read($, data)
      if (last && markerHere(d) !== last) await setMarker($, last)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'margin' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'hide' || arg === 'off') {
      await setHidden($, true)
      return { text: 'Margin row hidden. /margin show brings it back.' }
    }
    if (arg === 'show' || arg === 'on') {
      await setHidden($, false)
      return { text: 'Margin row is back above the prompt.' }
    }
    if (arg === 'toggle') {
      const now = !(await read($, hidden))
      await setHidden($, now)
      return { text: now ? 'Margin row hidden.' : 'Margin row shown.' }
    }
    if (arg === 'undo') {
      await undo($)
      return { text: 'Undid the last Margin change.' }
    }
    if (arg === 'sketch') {
      await startSketch($)
      return { text: 'Sketch pad opened under the latest reply.' }
    }
    if (arg === 'resume') {
      await openPane($, 'resume')
      return { text: 'Margin resume opened.' }
    }
    await openPane($, 'notebook')
    return { text: 'Margin notebook opened. Also: /margin hide, show, sketch, resume, undo.' }
  })

  on('ui.message', async ($, e) => {
    const msg = e.data as { type?: string; strokes?: number[][]; colors?: string[]; w?: number; h?: number }
    const rid = texts.has(e.requestId) ? e.requestId : (sketchingId ?? undefined)
    if (msg?.type === 'cancel') {
      await setSketching($, null)
      return {}
    }
    if (msg?.type === 'save' && Array.isArray(msg.strokes) && msg.strokes.length) {
      const now = await $.clock.now()
      const sk: Sketch = {
        id: `sk-${now.toString(36)}`,
        strokes: msg.strokes,
        ...(Array.isArray(msg.colors) ? { colors: msg.colors } : {}),
        w: msg.w ?? 100,
        h: msg.h ?? 50,
        at: now,
        session: here.session,
        where: here.where,
        ...(rid ? { requestId: rid, context: firstLine(texts.get(rid) ?? '', 90) } : {}),
      }
      sketchingId = null
      await save($, d => ({ ...d, sketches: [...d.sketches, sk] }))
      await say($, 'Sketch saved under the reply and in your notebook.')
    }
    return {}
  })

  // A reply block: draw its marks, marker and sketches; leave the rest alone.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const id = e.requestId
    if (!texts.has(id)) order.push(id)
    texts.set(id, e.props.text)
    if (e.props.isFirstOfReply) replyStarts.add(id)
    if (e.props.onScreen) visible.add(id)
    else if (e.props.onScreen === null) visible.delete(id)

    const { value: marks } = await $.state.get({ ...REPLY, id })
    if (!marks) return next(e)
    const hs = e.props.isSummary ? [] : marks.highlights
    if (hs.length === 0 && !marks.isMarked && marks.sketches.length === 0 && !marks.isSketching) return next(e)

    const { Box, Text, Markdown, Button } = $.ui.resolve(e)
    const body =
      hs.length === 0 ? (
        await next(e)
      ) : (
        <Box flexDirection="column" gap="sm">
          {layout(e.props.text, hs).map(p =>
            p.kind === 'md' ? (
              <Markdown text={p.md} />
            ) : (
              <Box flexDirection="column">
                <Text mono={p.isCode}>
                  {p.segments.map(s => (Object.keys(segmentProps(s)).length ? <Text {...segmentProps(s)}>{s.text}</Text> : s.text))}
                </Text>
                {p.notes.map(hl => (
                  <Text size="footnote" dimColor italic>
                    ✎ {hl.note}
                  </Text>
                ))}
              </Box>
            ),
          )}
        </Box>
      )

    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
    const sketches = marks.sketches.map(s => (
      <Box flexDirection="column" key={`sk-${s.id}`}>
        {Svg ? (
          <Svg source={sketchSvg(s, { paper: '#fffdf8' })} alt="Your sketch" width={Math.min(420, Math.max(160, s.w * 4))} />
        ) : (
          <Text dimColor>✏️ Your sketch (open /margin to see it)</Text>
        )}
        <Box flexDirection="row" gap="sm">
          <Button key={`skdel-${s.id}`} label="Remove sketch" dimColor onPress={() => removeSketch($, s.id)} />
        </Box>
      </Box>
    ))

    let pad = null
    if (marks.isSketching && (e.surface === 'terminal' || e.surface === 'desktop')) {
      const { Client } = $.ui.resolve(e)
      pad = <Client key={`pad-${id}`} module="./sketch.tsx" props={{ rows: 10 }} width="100%" />
    }

    const marker = marks.isMarked && (
      <Box flexDirection="row" alignItems="center" gap="sm" marginTop="sm">
        <Text color={MARKER_COLOR} weight="semibold">
          ── 📍 You stopped reading here ──
        </Text>
        <Button key="margin-unmark" label="Clear" dimColor onPress={() => clearMark($)} />
      </Box>
    )

    return (
      <Box flexDirection="column" gap="sm">
        {body}
        {sketches}
        {pad}
        {marker}
      </Box>
    )
  })

  // The row above the prompt: the controls.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const d = await read($, data)
    const noteFor = await read($, noting)
    const line = await read($, flash)
    const undoable = await read($, canUndo)
    const mine = Object.values(d.highlights).flat().filter(isMine)
    const m = markerHere(d)
    const fresh = m ? newSince(m) : 0
    const open = mine.find(x => x.id === noteFor)
    const small = cfg.compact

    if (await read($, hidden)) {
      return (
        <Box flexDirection="row" alignItems="center" gap="sm">
          <Button key="show" label="🖍 Margin" dimColor onPress={() => setHidden($, false)} />
          {m && <Button key="resume" label={fresh ? `📍 ${plural(fresh, 'new reply')}` : '📍 Resume'} dimColor onPress={() => resume($)} />}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap="xs">
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap="sm">
          {COLOR_NAMES.map(c => (
            <Button key={`hl-${c}`} hotkey={COLORS[c].key} onPress={() => highlight($, c)}>
              <Text {...lookOf(c)}>{small ? (COLORS[c].bg ? '   ' : c === 'underline' ? ' U ' : ' S ') : ` ${COLORS[c].label} `}</Text>
            </Button>
          ))}
          <Button key="erase" hotkey="e" label={small ? '⌫' : 'Erase'} dimColor onPress={() => erase($)} />
          {undoable && <Button key="undo" hotkey="u" label={small ? '↶' : '↶ Undo'} dimColor onPress={() => undo($)} />}
          <Text dimColor>│</Text>
          <Button key="mark" hotkey="m" label={small ? '📍' : '📍 Mark read here'} onPress={() => markHere($)} />
          {m && (
            <Button
              key="resume"
              hotkey="r"
              label={small ? `↩${fresh ? ` ${fresh}` : ''}` : fresh ? `Resume (${plural(fresh, 'new reply')})` : 'Resume'}
              onPress={() => resume($)}
            />
          )}
          {m && <Button key="unmark" label={small ? '✕📍' : 'Clear mark'} dimColor onPress={() => clearMark($)} />}
          <Text dimColor>│</Text>
          <Button key="quote" hotkey="q" label={small ? '❝' : '❝ Quote'} onPress={() => quote($)} />
          <Button key="sketch" hotkey="s" label={small ? '✏️' : sketchingId ? '✏️ Close sketch' : '✏️ Sketch here'} onPress={() => startSketch($)} />
          <Button key="notebook" hotkey="n" label={`📓${small ? '' : ' Notebook'}${mine.length ? ` (${mine.length})` : ''}`} onPress={() => openPane($, 'notebook')} />
          <Button key="hide" label="Hide Margin" role="dismiss" dimColor onPress={() => setHidden($, true)} />
        </Box>
        {open && (
          <Box flexDirection="row" alignItems="center" gap="sm">
            <Input
              key="note"
              label="Note:"
              placeholder={`on "${short(open.text, 30)}" (Enter to save, #tags work)`}
              value={open.note ?? ''}
              submitLabel="save"
              onSubmit={v => setNote($, open.id, v)}
            />
            <Button key="note-skip" label="Skip" dimColor onPress={() => update($, noting, () => null)} />
          </Box>
        )}
        <Text dimColor size="footnote">
          {line ?? HINT}
        </Text>
      </Box>
    )
  })

  // The pane: notebook, resume reading, one reply in full.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown, Input } = $.ui.resolve(e)
    const d = await read($, data)
    const v = await read($, view)
    const all = await read($, showAll)
    const width = Math.max(24, (e.props.bodyColumns ?? 60) - 4)
    const m = markerHere(d)
    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg

    const tabs = (
      <Box flexDirection="row" gap="sm" flexWrap="wrap">
        <Button key="tab-notebook" label="📓 Notebook" variant={v === 'notebook' ? 'primary' : 'secondary'} onPress={() => update($, view, () => 'notebook')} />
        <Button key="tab-resume" label="📍 Resume" variant={v === 'resume' ? 'primary' : 'secondary'} onPress={() => update($, view, () => 'resume')} />
      </Box>
    )

    // One reply in full, with its marks.
    const drawReply = (id: string) => {
      const md = texts.get(id) ?? ''
      const hs = d.highlights[id] ?? []
      if (hs.length === 0) return <Markdown text={md} />
      return (
        <Box flexDirection="column" gap="sm">
          {layout(md, hs).map(p =>
            p.kind === 'md' ? (
              <Markdown text={p.md} />
            ) : (
              <Box flexDirection="column">
                <Text mono={p.isCode}>
                  {p.segments.map(s => (Object.keys(segmentProps(s)).length ? <Text {...segmentProps(s)}>{s.text}</Text> : s.text))}
                </Text>
                {p.notes.map(hl => (
                  <Text dimColor italic>
                    ✎ {hl.note}
                  </Text>
                ))}
              </Box>
            ),
          )}
        </Box>
      )
    }

    if (v === 'reply') {
      const id = await read($, focus)
      return (
        <Box flexDirection="column" gap="sm">
          {tabs}
          {id && texts.has(id) ? (
            drawReply(id)
          ) : (
            <Text dimColor>That reply isn't in this session's view. Its highlights are still in your notebook.</Text>
          )}
          {id && <Button key="reply-mark" label="📍 Read up to here" dimColor onPress={() => setMarker($, id)} />}
        </Box>
      )
    }

    if (v === 'resume') {
      if (!m) {
        return (
          <Box flexDirection="column" gap="sm">
            {tabs}
            <Text dimColor>No marker yet. Press "📍 Mark read here" above the prompt when you stop reading.</Text>
          </Box>
        )
      }
      const after = order.slice(order.indexOf(m) + 1).filter(id => texts.has(id))
      return (
        <Box flexDirection="column" gap="sm">
          {tabs}
          <Text dimColor>You stopped after: {firstLine(texts.get(m) ?? '', width)}</Text>
          <Box flexDirection="row" gap="sm">
            <Button key="pane-unmark" label="Clear mark" dimColor onPress={() => clearMark($)} />
          </Box>
          {after.length === 0 ? (
            <Text>You're all caught up. Nothing new after your marker.</Text>
          ) : (
            after.map(id => (
              <Box flexDirection="column" key={`after-${id}`} gap="xs">
                {drawReply(id)}
                <Button key={`mark-${id}`} label="📍 Read up to here" dimColor onPress={() => setMarker($, id)} />
              </Box>
            ))
          )}
        </Box>
      )
    }

    const q = (await read($, query)).trim().toLowerCase()
    const only = await read($, filter)
    const list = Object.values(d.highlights)
      .flat()
      .filter(x => all || isMine(x))
      .filter(x => only === 'all' || x.color === only)
      .filter(x => !q || (x.text + ' ' + (x.note ?? '') + ' ' + (x.where ?? '')).toLowerCase().includes(q))
      .sort((a, b) => (all ? b.at - a.at : order.indexOf(a.requestId) - order.indexOf(b.requestId) || a.at - b.at))
    const sketches = d.sketches.filter(s => all || isMine(s)).sort((a, b) => b.at - a.at)
    const notes = list.filter(x => x.note).length

    return (
      <Box flexDirection="column" gap="sm">
        {tabs}
        <Text dimColor>
          {plural(list.length, 'highlight')} · {plural(notes, 'note')} · {plural(sketches.length, 'sketch')}
          {all ? ' · all sessions' : ' · this session'}
        </Text>
        <Input key="search" placeholder="Search highlights, notes, #tags" value={q} onInput={x => update($, query, () => x)} onSubmit={x => update($, query, () => x)} />
        <Box flexDirection="row" gap="xs" flexWrap="wrap" alignItems="center">
          <Button key="f-all" label="All" variant={only === 'all' ? 'primary' : 'secondary'} onPress={() => update($, filter, () => 'all')} />
          {COLOR_NAMES.map(c => (
            <Button key={`f-${c}`} onPress={() => update($, filter, x => (x === c ? 'all' : c))}>
              <Text {...lookOf(c)}>{only === c ? ` ✓ ${COLORS[c].label} ` : ` ${COLORS[c].label} `}</Text>
            </Button>
          ))}
        </Box>
        <Box flexDirection="row" gap="sm" flexWrap="wrap">
          <Button key="scope" label={all ? 'Showing: all sessions' : 'Showing: this session'} dimColor onPress={() => update($, showAll, x => !x)} />
          <Button key="copy-md" label="Copy as Markdown" dimColor onPress={() => copyAll($, list)} />
          {here.dir && cfg.writeFiles && <Button key="open-html" label="Open notebook in browser" dimColor onPress={() => openFile($, `${here.dir}/index.html`)} />}
          {here.dir && cfg.writeFiles && <Button key="open-dir" label="Open folder" dimColor onPress={() => openFile($, here.dir)} />}
        </Box>
        {m && <Text color={MARKER_COLOR}>📍 Marker on: {firstLine(texts.get(m) ?? '', width - 12)}</Text>}
        {list.length === 0 && sketches.length === 0 && (
          <Text dimColor>{q || only !== 'all' ? 'Nothing matches. Clear the search or the filter.' : 'Nothing yet. Select text in a reply, then pick a colour above the prompt.'}</Text>
        )}
        {list.map(hl => (
          <Box flexDirection="column" key={`row-${hl.id}`}>
            {hl.context && (
              <Text dimColor size="caption">
                {all && hl.where ? `${hl.where} · ` : ''}from: {short(hl.context, width)}
              </Text>
            )}
            <Text>
              <Text {...lookOf(hl.color)}>{short(hl.text, width * 2)}</Text>
            </Text>
            {hl.note && (
              <Text dimColor italic>
                ✎ {hl.note}
              </Text>
            )}
            <Box flexDirection="row" gap="sm">
              {texts.has(hl.requestId) && (
                <Button
                  key={`read-${hl.id}`}
                  label="Read reply"
                  dimColor
                  onPress={async () => {
                    await update($, focus, () => hl.requestId)
                    await update($, view, () => 'reply')
                  }}
                />
              )}
              <Button key={`note-${hl.id}`} label={hl.note ? 'Edit note' : 'Add note'} dimColor onPress={() => update($, noting, () => hl.id)} />
              <Button key={`del-${hl.id}`} label="Remove" dimColor onPress={() => removeHighlight($, hl)} />
            </Box>
          </Box>
        ))}
        {sketches.map(s => (
          <Box flexDirection="column" key={`psk-${s.id}`}>
            {s.context && <Text dimColor size="caption">under: {short(s.context, width)}</Text>}
            {Svg ? (
              <Svg source={sketchSvg(s, { paper: '#ffffff' })} alt="A sketch" width={Math.min(360, width * 7)} />
            ) : (
              <Text dimColor>✏️ Sketch saved {new Date(s.at).toISOString().slice(0, 16).replace('T', ' ')} (open the notebook in a browser to see it)</Text>
            )}
            <Button key={`pskdel-${s.id}`} label="Remove sketch" dimColor onPress={() => removeSketch($, s.id)} />
          </Box>
        ))}
      </Box>
    )
  })
}
