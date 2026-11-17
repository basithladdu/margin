import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Highlight, MarkColor, MarksData, PaneView, Sketch } from '../types'
import { sketchSvg } from './ink'
import { assign, blockHas, firstLine, layout, overlapping } from './marks'
import { notebookHtml, notebookMarkdown } from './notebook'

const STORE_KEY = 'margin-v1'
const PANE = 'margin'
const EMPTY: MarksData = { highlights: {}, markers: [], sketches: [] }

const data = atom({ plugin: 'margin', key: 'data' } as const, EMPTY, { shape: 'margin-1' })
const noting = atom({ plugin: 'margin', key: 'noting' } as const, null)
const flash = atom({ plugin: 'margin', key: 'flash' } as const, null)
const view = atom({ plugin: 'margin', key: 'view' } as const, 'notebook')
const showAll = atom({ plugin: 'margin', key: 'showAll' } as const, false)
const hidden = atom({ plugin: 'margin', key: 'hidden' } as const, false)
const query = atom({ plugin: 'margin', key: 'query' } as const, '')
const filter = atom({ plugin: 'margin', key: 'filter' } as const, 'all')
const UI_KEY = 'margin-ui'

const COLORS: Record<MarkColor, { bg: string; fg: string; label: string; key: string }> = {
  yellow: { bg: '#fde68a', fg: '#1c1917', label: 'Yellow', key: '1' },
  green: { bg: '#bbf7d0', fg: '#1c1917', label: 'Green', key: '2' },
  pink: { bg: '#fbcfe8', fg: '#1c1917', label: 'Pink', key: '3' },
  blue: { bg: '#bfdbfe', fg: '#1c1917', label: 'Blue', key: '4' },
  orange: { bg: '#fed7aa', fg: '#1c1917', label: 'Orange', key: '5' },
}
const COLOR_NAMES = Object.keys(COLORS) as MarkColor[]
const MARKER_COLOR = '#d97706'
const HINT = 'Select text in a reply, then pick a colour. Erase takes it off. Quote asks Claude about it. /margin hide folds this row away.'

// What this run of the module has seen drawn: reply blocks in order. Rebuilt
// as the transcript draws after a reload.
const texts = new Map<string, string>()
const order: string[] = []
const visible = new Set<string>()
const here = { session: '', where: '', dir: '', isWindows: false, isMac: false }
// The person's settings (userConfig in plugin.json), read at each load.
const cfg = { folder: '', startHidden: false, compact: false, writeFiles: true }

const seen = () => order.filter(id => texts.has(id)).map(id => ({ id, md: texts.get(id)! }))
const markerHere = (d: MarksData) => d.markers.find(m => texts.has(m))
const short = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}
const isMine = (h: { session?: string; requestId?: string }) =>
  (h.session !== undefined && h.session === here.session) || (h.requestId !== undefined && texts.has(h.requestId))

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

async function save($: EngineInterface, change: (d: MarksData) => MarksData) {
  const next = await update($, data, change)
  await $.store.set(STORE_KEY, next)
  await writeNotebook($, next)
  return next
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
        // Same text, same colour again: take it off.
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
        ...(old?.note ? { note: old.note } : {}),
      }
      highlights[t.id] = [...list.filter(x => x.text !== t.text), hl]
      lastId = hl.id
    })
    for (const k of Object.keys(highlights)) if (highlights[k]!.length === 0) delete highlights[k]
    return { ...d, highlights }
  })
  await update($, noting, () => lastId)
  await say($, lastId ? 'Highlighted. Add a note below, or just keep reading.' : removed ? 'Highlight removed.' : null)
}

async function erase($: EngineInterface) {
  const { text, targets } = await targetsOf($)
  if (!text) return say($, 'Select the highlighted text you want to clear, then press Erase.')
  let gone = 0
  await save($, d => {
    const highlights = { ...d.highlights }
    for (const t of targets) {
      const list = highlights[t.id] ?? []
      const hit = new Set(overlapping(texts.get(t.id) ?? '', list, t.text).map(x => x.id))
      gone += hit.size
      const left = list.filter(x => !hit.has(x.id))
      if (left.length) highlights[t.id] = left
      else delete highlights[t.id]
    }
    return { ...d, highlights }
  })
  await update($, noting, () => null)
  await say($, gone ? `Removed ${gone} highlight${gone > 1 ? 's' : ''}.` : 'No highlight in that selection.')
}

async function markHere($: EngineInterface) {
  const sel = await $.ui.selection()
  let target: string | undefined
  if (sel?.requestId && texts.has(sel.requestId)) target = sel.requestId
  if (!target && sel?.text.trim()) target = assign(sel.text, seen()).pop()?.id
  if (!target) target = order.filter(id => visible.has(id)).pop() ?? order[order.length - 1]
  if (!target) return say($, 'No reply to mark yet.')
  const mine = new Set(order)
  await save($, d => ({ ...d, markers: [target!, ...d.markers.filter(m => !mine.has(m))].slice(0, 300) }))
  await say($, sel?.text.trim() ? 'Marked where you stopped.' : 'Marked the latest reply. Select text in a reply first to mark that one.')
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
  return list
    .map(x => `> ${x.text.replace(/\n/g, '\n> ')}` + (x.note ? `\n\n${x.note}` : ''))
    .join('\n\n---\n\n')
}

async function copyAll($: EngineInterface, list: readonly Highlight[]) {
  if (list.length === 0) return say($, 'Nothing to copy yet.')
  const r = await $.ui.copy({ text: asMarkdown(list) })
  await say($, r.isCopied ? `Copied ${list.length} highlight${list.length > 1 ? 's' : ''} as Markdown.` : "Couldn't copy here. Open the notebook in your browser instead.")
}

export const register: Register = (on, options) => {
  cfg.folder = typeof options.notebookFolder === 'string' ? options.notebookFolder.trim() : ''
  cfg.startHidden = options.startHidden === true
  cfg.compact = options.rowStyle === 'compact'
  cfg.writeFiles = options.saveNotebook !== false

  on('session.start', async ($, e, next) => {
    const stored = normalize(await $.store.get(STORE_KEY))
    if (stored) await update($, data, () => stored)
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
      argumentHint: '[hide | show | sketch | resume]',
    })
    return next(e)
  })

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
    if (arg === 'sketch' || arg === 'resume') {
      await openPane($, arg)
      return { text: `Margin ${arg} opened.` }
    }
    await openPane($, 'notebook')
    return { text: 'Margin notebook opened. Also: /margin hide, /margin show, /margin sketch, /margin resume.' }
  })

  on('ui.message', async ($, e) => {
    const msg = e.data as { type?: string; strokes?: number[][]; w?: number; h?: number }
    if (msg?.type === 'save' && Array.isArray(msg.strokes) && msg.strokes.length) {
      const now = await $.clock.now()
      const sk: Sketch = {
        id: `sk-${now.toString(36)}`,
        strokes: msg.strokes,
        w: msg.w ?? 100,
        h: msg.h ?? 50,
        at: now,
        session: here.session,
        where: here.where,
      }
      await save($, d => ({ ...d, sketches: [...d.sketches, sk] }))
      await say($, 'Sketch saved to your notebook.')
    }
    return {}
  })

  // A reply block: draw its highlights and the marker; leave the rest alone.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const id = e.requestId
    if (!texts.has(id)) order.push(id)
    texts.set(id, e.props.text)
    if (e.props.onScreen) visible.add(id)
    else if (e.props.onScreen === null) visible.delete(id)

    const d = await read($, data)
    const hs = e.props.isSummary ? [] : (d.highlights[id] ?? [])
    const isMarked = d.markers.includes(id)
    if (hs.length === 0 && !isMarked) return next(e)

    const { Box, Text, Markdown, Button } = $.ui.resolve(e)
    const marker = isMarked && (
      <Box flexDirection="row" alignItems="center" gap="sm" marginTop="sm">
        <Text color={MARKER_COLOR} weight="semibold">
          ── 📍 You stopped reading here ──
        </Text>
        <Button key="margin-unmark" label="Clear" dimColor onPress={() => clearMark($)} />
      </Box>
    )
    if (hs.length === 0) {
      return (
        <Box flexDirection="column">
          {await next(e)}
          {marker}
        </Box>
      )
    }

    const pieces = layout(e.props.text, hs)
    return (
      <Box flexDirection="column" gap="sm">
        {pieces.map(p =>
          p.kind === 'md' ? (
            <Markdown text={p.md} />
          ) : (
            <Box flexDirection="column">
              <Text mono={p.isCode}>
                {p.segments.map(s =>
                  s.color ? (
                    <Text backgroundColor={COLORS[s.color].bg} color={COLORS[s.color].fg}>
                      {s.text}
                    </Text>
                  ) : (
                    s.text
                  ),
                )}
              </Text>
              {p.notes.map(hl => (
                <Text size="footnote" dimColor italic>
                  ✎ {hl.note}
                </Text>
              ))}
            </Box>
          ),
        )}
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
    const mine = Object.values(d.highlights).flat().filter(isMine)
    const hasMarker = markerHere(d) !== undefined
    const open = mine.find(x => x.id === noteFor)
    const small = cfg.compact

    if (await read($, hidden)) {
      return (
        <Box flexDirection="row" alignItems="center" gap="sm">
          <Button key="show" label="🖍 Margin" dimColor onPress={() => setHidden($, false)} />
          {hasMarker && <Button key="resume" label="📍 Resume" dimColor onPress={() => resume($)} />}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap="xs">
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap="sm">
          {COLOR_NAMES.map(c => (
            <Button key={`hl-${c}`} hotkey={COLORS[c].key} onPress={() => highlight($, c)}>
              <Text backgroundColor={COLORS[c].bg} color={COLORS[c].fg}>
                {small ? '   ' : ` ${COLORS[c].label} `}
              </Text>
            </Button>
          ))}
          <Button key="erase" hotkey="e" label={small ? '⌫' : 'Erase'} dimColor onPress={() => erase($)} />
          <Text dimColor>│</Text>
          <Button key="mark" hotkey="m" label={small ? '📍' : '📍 Mark read here'} onPress={() => markHere($)} />
          {hasMarker && <Button key="resume" hotkey="r" label={small ? '↩' : 'Resume'} onPress={() => resume($)} />}
          {hasMarker && <Button key="unmark" label={small ? '✕📍' : 'Clear mark'} dimColor onPress={() => clearMark($)} />}
          <Text dimColor>│</Text>
          <Button key="quote" hotkey="q" label={small ? '❝' : '❝ Quote'} onPress={() => quote($)} />
          <Button key="notebook" hotkey="n" label={`📓${small ? '' : ' Notebook'}${mine.length ? ` (${mine.length})` : ''}`} onPress={() => openPane($, 'notebook')} />
          <Button key="sketch" hotkey="s" label={small ? '✏️' : '✏️ Sketch'} onPress={() => openPane($, 'sketch')} />
          <Button key="hide" label="Hide Margin" role="dismiss" dimColor onPress={() => setHidden($, true)} />
        </Box>
        {open && (
          <Box flexDirection="row" alignItems="center" gap="sm">
            <Input
              key="note"
              label="Note:"
              placeholder={`on "${short(open.text, 30)}" (Enter to save)`}
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

  // The pane: notebook, resume reading, sketch pad.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const d = await read($, data)
    const v = await read($, view)
    const all = await read($, showAll)
    const width = Math.max(24, (e.props.bodyColumns ?? 60) - 4)
    const m = markerHere(d)

    const tabs = (
      <Box flexDirection="row" gap="sm" flexWrap="wrap">
        {(['notebook', 'resume', 'sketch'] as const).map(t => (
          <Button
            key={`tab-${t}`}
            label={t === 'notebook' ? '📓 Notebook' : t === 'resume' ? '📍 Resume' : '✏️ Sketch'}
            variant={v === t ? 'primary' : 'secondary'}
            onPress={() => update($, view, () => t)}
          />
        ))}
      </Box>
    )

    if (v === 'sketch') {
      if (e.surface !== 'terminal' && e.surface !== 'desktop') {
        return (
          <Box flexDirection="column" gap="sm">
            {tabs}
            <Text dimColor>The sketch pad needs the desktop app or a terminal.</Text>
          </Box>
        )
      }
      const { Client } = $.ui.resolve(e)
      return (
        <Box flexDirection="column" gap="sm">
          {tabs}
          <Text dimColor>Drag inside the box to draw. Saved sketches go to your notebook as smooth SVGs.</Text>
          <Client key="pad" module="./sketch.tsx" props={{ rows: 14 }} width="100%" />
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
              <Box flexDirection="column" key={`after-${id}`}>
                <Markdown text={texts.get(id)!} />
                <Button key={`mark-${id}`} label="📍 Read up to here" dimColor onPress={() => save($, dd => ({ ...dd, markers: [id, ...dd.markers.filter(x => !order.includes(x))] }))} />
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
      .filter(x => !q || (x.text + ' ' + (x.note ?? '')).toLowerCase().includes(q))
      .sort((a, b) => (all ? b.at - a.at : order.indexOf(a.requestId) - order.indexOf(b.requestId) || a.at - b.at))
    const sketches = d.sketches.filter(s => all || s.session === here.session).sort((a, b) => b.at - a.at)
    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
    const canSvg = Svg !== undefined
    const { Input } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap="sm">
        {tabs}
        <Input
          key="search"
          placeholder="Search highlights and notes"
          value={q}
          onInput={v => update($, query, () => v)}
          onSubmit={v => update($, query, () => v)}
        />
        <Box flexDirection="row" gap="xs" flexWrap="wrap" alignItems="center">
          <Button key="f-all" label="All" variant={only === 'all' ? 'primary' : 'secondary'} onPress={() => update($, filter, () => 'all')} />
          {COLOR_NAMES.map(c => (
            <Button key={`f-${c}`} onPress={() => update($, filter, x => (x === c ? 'all' : c))}>
              <Text backgroundColor={COLORS[c].bg} color={COLORS[c].fg}>
                {only === c ? ` ✓ ${COLORS[c].label} ` : ` ${COLORS[c].label} `}
              </Text>
            </Button>
          ))}
        </Box>
        <Box flexDirection="row" gap="sm" flexWrap="wrap">
          <Button key="scope" label={all ? 'Showing: all sessions' : 'Showing: this session'} dimColor onPress={() => update($, showAll, x => !x)} />
          <Button key="copy-md" label="Copy as Markdown" dimColor onPress={() => copyAll($, list)} />
          {here.dir && cfg.writeFiles && <Button key="open-html" label="Open in browser" dimColor onPress={() => openFile($, `${here.dir}/index.html`)} />}
          {here.dir && cfg.writeFiles && <Button key="open-dir" label="Open folder" dimColor onPress={() => openFile($, here.dir)} />}
        </Box>
        {m && (
          <Text color={MARKER_COLOR}>📍 Marker on: {firstLine(texts.get(m) ?? '', width - 12)}</Text>
        )}
        {list.length === 0 && sketches.length === 0 && (
          <Text dimColor>Nothing yet. Select text in a reply, then pick a colour above the prompt.</Text>
        )}
        {list.map(hl => (
          <Box flexDirection="column" key={`row-${hl.id}`}>
            <Text>
              <Text backgroundColor={COLORS[hl.color].bg} color={COLORS[hl.color].fg}>
                {short(hl.text, width * 2)}
              </Text>
            </Text>
            {hl.note && (
              <Text dimColor italic>
                ✎ {hl.note}
              </Text>
            )}
            {all && hl.where && <Text dimColor size="caption">{hl.where}</Text>}
            <Box flexDirection="row" gap="sm">
              <Button key={`note-${hl.id}`} label={hl.note ? 'Edit note' : 'Add note'} dimColor onPress={() => update($, noting, () => hl.id)} />
              <Button key={`del-${hl.id}`} label="Remove" dimColor onPress={() => removeHighlight($, hl)} />
            </Box>
          </Box>
        ))}
        {sketches.map(s =>
          canSvg ? (
            <Box flexDirection="column" key={`sk-${s.id}`}>
              {Svg && <Svg source={sketchSvg(s, { ink: '#57534e', paper: '#ffffff' })} alt="A sketch" width={Math.min(360, width * 7)} />}
              <Button key={`skdel-${s.id}`} label="Remove sketch" dimColor onPress={() => save($, dd => ({ ...dd, sketches: dd.sketches.filter(x => x.id !== s.id) }))} />
            </Box>
          ) : (
            <Text dimColor>✏️ Sketch saved {new Date(s.at).toISOString().slice(0, 16).replace('T', ' ')} (open the notebook to see it)</Text>
          ),
        )}
      </Box>
    )
  })
}
