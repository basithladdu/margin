// Builds the notebook files: index.html to browse (one self-contained page that
// works opened from disk, offline), and notebook.md for any notes app
// (Obsidian, Logseq). Sketches are written as sketches/<id>.svg by register.tsx.

import type { Highlight, MarkColor, MarksData, Sketch } from '../types'
import { sketchSvg } from './ink'

const COLORS: MarkColor[] = ['yellow', 'green', 'pink', 'blue', 'orange', 'underline', 'strike']
const STYLE_NAME: Record<MarkColor, string> = {
  yellow: 'Yellow',
  green: 'Green',
  pink: 'Pink',
  blue: 'Blue',
  orange: 'Orange',
  underline: 'Underline',
  strike: 'Strike',
}
const MD_STYLE: Record<MarkColor, string> = {
  yellow: 'yellow highlight',
  green: 'green highlight',
  pink: 'pink highlight',
  blue: 'blue highlight',
  orange: 'orange highlight',
  underline: 'underlined',
  strike: 'struck through',
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]!)
const lower = (s: unknown) => String(s ?? '').toLowerCase()

const iso = (ms: number) => {
  const t = new Date(ms)
  return Number.isNaN(t.getTime()) ? '' : t.toISOString()
}
const day = (ms: number) => iso(ms).slice(0, 10)
const clock = (ms: number) => iso(ms).slice(11, 16)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const colorOf = (c: unknown): MarkColor => ((COLORS as string[]).includes(String(c)) ? (c as MarkColor) : 'yellow')
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const opening = (s: string) => {
  const t = oneLine(s)
  return /[….!?:]$/.test(t) ? t : `${t}…`
}

// #tags in notes: a letter first, then letters, digits, _ or -. "#12" (issue
// numbers) and "a#b" are not tags.
const TAG = /(^|[^\p{L}\p{N}_&#])#(\p{L}(?:[\p{L}\p{N}_-]*[\p{L}\p{N}_])?)/gu

type Piece = { text: string; tag?: string }

function splitTags(note: string): Piece[] {
  const out: Piece[] = []
  const re = new RegExp(TAG.source, TAG.flags)
  let last = 0
  for (let m = re.exec(note); m; m = re.exec(note)) {
    const start = m.index + m[1]!.length
    if (start > last) out.push({ text: note.slice(last, start) })
    out.push({ text: `#${m[2]}`, tag: m[2]!.toLowerCase() })
    last = start + 1 + m[2]!.length
  }
  if (last < note.length) out.push({ text: note.slice(last) })
  return out
}

const tagsOf = (note?: string) => [...new Set(splitTags(note ?? '').flatMap(p => (p.tag ? [p.tag] : [])))]

// ---------------------------------------------------------------- grouping

type Reply = { id: string; context?: string; marked: boolean; items: Highlight[] }
type Session = {
  key: string
  where: string
  first: number
  highlights: Highlight[]
  replies: Reply[]
  sketches: Sketch[]
}

function sessions(d: MarksData): Session[] {
  const by = new Map<string, Session>()
  const get = (session: string | undefined, where: string | undefined, at: number) => {
    const key = session || `day-${day(at)}`
    let g = by.get(key)
    if (!g) {
      g = { key, where: where || 'Claude Code', first: at, highlights: [], replies: [], sketches: [] }
      by.set(key, g)
    }
    if (where && g.where === 'Claude Code') g.where = where
    g.first = Math.min(g.first, at)
    return g
  }
  for (const list of Object.values(d.highlights ?? {}))
    for (const hl of list ?? []) if (hl && typeof hl.text === 'string') get(hl.session, hl.where, hl.at).highlights.push(hl)
  for (const s of d.sketches ?? []) if (s) get(s.session, s.where, s.at).sketches.push(s)

  const marked = new Set(d.markers ?? [])
  for (const g of by.values()) {
    g.highlights.sort((a, b) => a.at - b.at)
    g.sketches.sort((a, b) => a.at - b.at)
    // Replies in the order their first highlight was made; highlights in the
    // order they were made inside each reply.
    const replies = new Map<string, Reply>()
    for (const hl of g.highlights) {
      let r = replies.get(hl.requestId)
      if (!r) {
        r = { id: hl.requestId, marked: marked.has(hl.requestId), items: [] }
        replies.set(hl.requestId, r)
      }
      if (!r.context && hl.context) r.context = hl.context
      r.items.push(hl)
    }
    g.replies = [...replies.values()]
  }
  return [...by.values()].sort((a, b) => b.first - a.first)
}

type Totals = { highlights: number; notes: number; sketches: number; sessions: number }

function totals(list: Session[]): Totals {
  let highlights = 0
  let notes = 0
  let sketches = 0
  for (const g of list) {
    highlights += g.highlights.length
    notes += g.highlights.filter(hl => hl.note?.trim()).length
    sketches += g.sketches.length
  }
  return { highlights, notes, sketches, sessions: list.length }
}

const summary = (t: Totals) =>
  [plural(t.highlights, 'highlight'), plural(t.notes, 'note'), plural(t.sketches, 'sketch', 'sketches'), plural(t.sessions, 'session')].join(' · ')

// ---------------------------------------------------------------- markdown

/** Notes apps render raw HTML in Markdown; a backslash keeps "<" as text. */
const noHtml = (s: string) => s.replace(/</g, '\\<')
const mdInline = (s: string) => oneLine(s).replace(/([\\`*_[\]<>])/g, '\\$1')
const quoteMd = (text: string) =>
  text
    .replace(/\s+$/, '')
    .split(/\r?\n/)
    .map(l => (l.trim() ? `> ${l}` : '>'))
    .join('\n')

/** What a card's copy button puts on the clipboard. */
const cardMd = (hl: Highlight) => quoteMd(hl.text) + (hl.note?.trim() ? `\n\n${hl.note.trim()}` : '')

const HINT = 'Press / to search. Click a #tag in any note to filter by it.'
const EMPTY_HOW =
  "Select some text in one of Claude's replies, then press a colour in the Margin row above the prompt. Add a note with #tags to find it again later."

export function notebookMarkdown(d: MarksData): string {
  const list = sessions(d)
  const t = totals(list)
  const out = ['# Margin notebook', '']
  if (!t.highlights && !t.sketches) {
    out.push('Nothing here yet.', '', EMPTY_HOW, '')
    return out.join('\n')
  }
  out.push(`${summary(t)}. Newest session first.`, '')
  for (const g of list) {
    out.push(`## ${mdInline(g.where)} · ${day(g.first)}`, '')
    for (const r of g.replies) {
      const ctx = r.context ? `From the reply: “${mdInline(opening(r.context))}”` : ''
      const line = [ctx, r.marked ? 'read up to here' : ''].filter(Boolean).join(' · ')
      if (line) out.push(`*${line}*`, '')
      for (const hl of r.items) {
        out.push(quoteMd(noHtml(hl.text)), '>', `> — ${MD_STYLE[colorOf(hl.color)]} · ${day(hl.at)} ${clock(hl.at)} UTC`, '')
        if (hl.note?.trim()) out.push(noHtml(hl.note.trim()), '')
      }
    }
    for (const s of g.sketches) {
      if (s.context) out.push(`*Sketch under: “${mdInline(opening(s.context))}”*`, '')
      out.push(`![sketch](sketches/${encodeURIComponent(s.id)}.svg)`, '')
    }
  }
  return out.join('\n')
}

// ---------------------------------------------------------------- html

const ICON = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  download: '<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14"/>',
  theme: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  print: '<path d="M7 9V4h10v5M7 17H5.5A1.5 1.5 0 0 1 4 15.5V11a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4.5a1.5 1.5 0 0 1-1.5 1.5H17"/><path d="M7 14h10v6H7z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
}
const icon = (k: keyof typeof ICON) =>
  `<svg class="i" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`

const textHtml = (s: string) => esc(s.replace(/\s+$/, '')).replace(/\r?\n/g, '<br>')

function noteHtml(note: string): string {
  return splitTags(note.trim())
    .map(p =>
      p.tag
        ? `<button type="button" class="tag" data-tag="${esc(p.tag)}" aria-label="Filter by tag ${esc(p.text)}">${esc(p.text)}</button>`
        : esc(p.text).replace(/\r?\n/g, '<br>'),
    )
    .join('')
}

const timeHtml = (ms: number) => `<time datetime="${esc(iso(ms))}" data-at="${ms}">${esc(day(ms))} ${esc(clock(ms))} UTC</time>`
const dayHtml = (ms: number) => `<time datetime="${esc(day(ms))}" data-day="${ms}">${esc(day(ms))}</time>`
const shortDayHtml = (ms: number) => `<time datetime="${esc(day(ms))}" data-short="${ms}">${esc(day(ms))}</time>`

function cardHtml(hl: Highlight, sid: string, pid: number, where: string): string {
  const c = colorOf(hl.color)
  const note = hl.note?.trim() ?? ''
  const tags = tagsOf(note)
  const hay = lower([hl.text, note, tags.map(t => `#${t}`).join(' '), where, hl.context ?? ''].join(' \n '))
  const tagName = c === 'underline' || c === 'strike' ? 'span' : 'mark'
  return `<article class="card c-${c}" data-s="${sid}" data-p="${pid}" data-c="${c}" data-note="${note ? 1 : 0}" data-tags="${esc(tags.join(' '))}" data-hay="${esc(hay)}" data-md="${esc(cardMd(hl))}">
<blockquote class="quote"><${tagName} class="m m-${c} hl">${textHtml(hl.text)}</${tagName}></blockquote>
${note ? `<p class="note hl">${noteHtml(note)}</p>` : ''}
<footer class="foot"><span class="sr">${STYLE_NAME[c]}${c === 'underline' || c === 'strike' ? '' : ' highlight'}, </span>${timeHtml(hl.at)}<button type="button" class="copy ghost" aria-label="Copy this highlight as Markdown">${icon('copy')}<span class="lbl">Copy</span></button></footer>
</article>`
}

function sketchHtml(s: Sketch, sid: string, pid: number, where: string): string {
  const ctx = s.context ? opening(s.context) : ''
  return `<figure class="sk" data-s="${sid}" data-p="${pid}" data-id="${esc(s.id)}" data-hay="${esc(lower(`${where} ${ctx}`))}">
<div class="paper" role="img" aria-label="Sketch${ctx ? ` drawn under the reply ${esc(ctx)}` : ''}">${sketchSvg(s, { ink: '#1c1917', paper: '#ffffff' })}</div>
<figcaption>${ctx ? `<q>${esc(ctx)}</q>` : '<span>Drawn in the sketch pad</span>'}${timeHtml(s.at)}</figcaption>
</figure>`
}

function sessionHtml(g: Session, i: number, pid: number): string {
  const sid = `s${i}`
  const notes = g.highlights.filter(hl => hl.note?.trim()).length
  const meta = [
    dayHtml(g.first),
    g.highlights.length ? plural(g.highlights.length, 'highlight') : '',
    notes ? plural(notes, 'note') : '',
    g.sketches.length ? plural(g.sketches.length, 'sketch', 'sketches') : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const replies = g.replies
    .map(r => {
      const ctx = r.context ? opening(r.context) : ''
      return `<div class="reply" data-ctx="${esc(ctx ? `From the reply: “${mdInline(ctx)}”` : '')}">
${ctx || r.marked ? `<p class="ctx">${ctx ? `<span class="k">Reply</span><q>${esc(ctx)}</q>` : ''}${r.marked ? '<span class="pin">Read up to here</span>' : ''}</p>` : ''}
${r.items.map(hl => cardHtml(hl, sid, pid, g.where)).join('\n')}
</div>`
    })
    .join('\n')
  const gallery = g.sketches.length
    ? `<div class="gwrap"><h3 class="gh">Sketches</h3><div class="gallery">${g.sketches.map(s => sketchHtml(s, sid, pid, g.where)).join('\n')}</div></div>`
    : ''
  return `<section class="session" id="${sid}" data-s="${sid}" data-title="${esc(`${mdInline(g.where)} · ${day(g.first)}`)}" aria-labelledby="${sid}-h">
<header class="shead"><h2 id="${sid}-h">${esc(g.where)}</h2><p class="smeta">${meta}</p></header>
${replies}
${gallery}
</section>`
}

function chip(f: string, v: string, label: string, n: number, extra = '') {
  return `<button type="button" class="chip" data-f="${f}" data-v="${esc(v)}" aria-pressed="false">${extra}${label}<span class="ct">${n}</span></button>`
}

export function notebookHtml(d: MarksData): string {
  const list = sessions(d)
  const t = totals(list)
  const empty = !t.highlights && !t.sketches

  const projects = [...new Set(list.map(g => g.where))]
  const pidOf = (where: string) => projects.indexOf(where)

  const colorCount = new Map<MarkColor, number>()
  const tagCount = new Map<string, number>()
  for (const g of list)
    for (const hl of g.highlights) {
      const c = colorOf(hl.color)
      colorCount.set(c, (colorCount.get(c) ?? 0) + 1)
      for (const tag of tagsOf(hl.note)) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1)
    }

  const colorChips = COLORS.filter(c => colorCount.get(c))
    .map(c =>
      c === 'underline' || c === 'strike'
        ? chip('c', c, `<span class="st st-${c}">${STYLE_NAME[c]}</span>`, colorCount.get(c)!)
        : chip('c', c, STYLE_NAME[c], colorCount.get(c)!, `<span class="sw" style="background:var(--${c})" aria-hidden="true"></span>`),
    )
    .join('')
  const noteChip = t.notes ? chip('note', '1', 'Has a note', t.notes) : ''
  const tagChips = [...tagCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, n]) => chip('t', tag, `#${esc(tag)}`, n))
    .join('')
  const projectChips =
    projects.length > 1
      ? projects
          .map((p, i) => chip('p', String(i), esc(p), list.filter(g => g.where === p).reduce((n, g) => n + g.highlights.length + g.sketches.length, 0)))
          .join('')
      : ''

  const filters = empty
    ? ''
    : `<details class="filters" id="fbox" open><summary>Filters<span id="fcount"></span></summary><div class="fbody">
<div class="frow" role="group" aria-label="Filter by style"><span class="fl">Style</span>${colorChips}${noteChip}</div>
${tagChips ? `<div class="frow" role="group" aria-label="Filter by tag"><span class="fl">Tags</span>${tagChips}</div>` : ''}
${projectChips ? `<div class="frow" role="group" aria-label="Filter by project"><span class="fl">Project</span>${projectChips}</div>` : ''}
</div></details>
<div class="frow pick"><label class="fl" for="sess">Session</label><select id="sess"><option value="">All sessions (${list.length})</option>${list
        .map(
          (g, i) =>
            `<option value="s${i}" data-label="${esc(g.where)}" data-day="${g.first}" data-n="${g.highlights.length + g.sketches.length}">${esc(g.where)} · ${day(g.first)} (${g.highlights.length + g.sketches.length})</option>`,
        )
        .join('')}</select></div>
<div class="statusrow"><p id="count" aria-live="polite">${HINT}</p><button type="button" id="clear" class="ghost" hidden>Clear filters</button></div>`

  const side = empty
    ? ''
    : `<nav class="side" aria-label="Sessions"><h2 class="sideh">Sessions</h2><ul>
<li><button type="button" class="sbtn" data-sess="" aria-current="true"><span class="sp">All sessions</span><span class="sm">${plural(t.highlights, 'highlight')}${t.sketches ? ` · ${plural(t.sketches, 'sketch', 'sketches')}` : ''}</span></button></li>
${list
  .map(
    (g, i) =>
      `<li><button type="button" class="sbtn" data-sess="s${i}" aria-current="false"><span class="sp">${esc(g.where)}</span><span class="sm">${shortDayHtml(g.first)} · ${[g.highlights.length || !g.sketches.length ? plural(g.highlights.length, 'highlight') : '', g.sketches.length ? plural(g.sketches.length, 'sketch', 'sketches') : ''].filter(Boolean).join(', ')}</span></button></li>`,
  )
  .join('\n')}
</ul></nav>`

  const body = empty
    ? `<section class="empty">
<p class="demo" aria-hidden="true">“Whatever you mark in Claude Code <mark class="m m-yellow">lands here</mark>, with your <span class="m m-underline">notes</span> beside it.”</p>
<h2>Your notebook is empty, for now</h2>
<ol>
<li><b>Select some text</b> in one of Claude's replies.</li>
<li><b>Press a colour</b> in the Margin row above the prompt (or Underline / Strike).</li>
<li><b>Add a note</b> if you like. Words like <span class="tag">#todo</span> or <span class="tag">#idea</span> become tags you can filter by.</li>
</ol>
<p class="dim">Highlights and sketches show up here grouped by session, newest first. This page refreshes each time you mark something; it stays on this computer.</p>
</section>`
    : `${list.map((g, i) => sessionHtml(g, i, pidOf(g.where))).join('\n')}
<section class="none" id="none" hidden><h2>Nothing matches</h2><p class="dim">Try fewer words, or clear the filters.</p><button type="button" id="clear2" class="btn">Clear filters</button></section>`

  const tools = empty
    ? `<div class="tools"><button type="button" class="btn" id="theme" aria-label="Switch theme">${icon('theme')}<span class="lbl">Dark</span></button></div>`
    : `<div class="tools" role="toolbar" aria-label="Notebook actions">
<button type="button" class="btn" id="copyall" title="Copy all visible as Markdown">${icon('copy')}<span class="lbl">Copy visible</span></button>
<button type="button" class="btn" id="dl" title="Download what's visible as a Markdown file">${icon('download')}<span class="lbl">Download .md</span></button>
<button type="button" class="btn" id="theme" aria-label="Switch theme">${icon('theme')}<span class="lbl">Dark</span></button>
<button type="button" class="btn" id="print" title="Print">${icon('print')}<span class="lbl">Print</span></button>
</div>`

  const search = empty
    ? ''
    : `<div class="search">${icon('search')}<label class="sr" for="q">Search highlights, notes, tags and projects</label><input id="q" type="search" placeholder="Search text, notes, #tags, projects" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">/</kbd></div>`

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Margin notebook</title>
<script>try{var t=localStorage.getItem('margin-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>
<style>${CSS}</style></head>
<body data-total="${t.highlights}" data-sk="${t.sketches}">
<a class="skip" href="#results">Skip to highlights</a>
<div class="wrap">
<header class="top">
<div class="title"><h1><span class="dot" aria-hidden="true"></span>Margin notebook</h1>
<p class="stats">${empty ? 'Highlights, notes and sketches from Claude Code.' : summary(t).replace(/(\d+)/g, '<b>$1</b>')}</p></div>
${tools}
${search}
${filters}
</header>
<div class="layout${empty ? ' solo' : ''}">
${side}
<main id="results" tabindex="-1">
${body}
</main>
</div>
<footer class="end">Made with Margin for Claude Code. Kept on this computer only.</footer>
</div>
<div id="status" class="sr" role="status" aria-live="polite"></div>
<script>${JS}</script>
</body></html>`
}

// ---------------------------------------------------------------- page assets

const CSS = String.raw`
:root{--bg:#faf6ec;--fg:#1c1917;--dim:#655e55;--card:#fffdf7;--line:#e6dcc8;--soft:#f3ecdb;--chip:#fffdf7;--accent:#ea580c;--accent-ink:#c2410c;--hit:#c2410c;
--yellow:#fde68a;--green:#bbf7d0;--pink:#fbcfe8;--blue:#bfdbfe;--orange:#fed7aa;--underline:#ea580c;--strike:#8a8178;
--shadow:0 1px 0 rgba(60,40,10,.04),0 2px 8px -4px rgba(60,40,10,.12);
--serif:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,'Times New Roman',serif;
--sans:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#1a1917;--fg:#f5f2ea;--dim:#aaa298;--card:#23211e;--line:#3a3630;--soft:#2c2925;--chip:#23211e;--accent:#fb923c;--accent-ink:#fdba74;--strike:#aaa298;--shadow:0 1px 0 rgba(0,0,0,.2);color-scheme:dark}}
:root[data-theme=dark]{--bg:#1a1917;--fg:#f5f2ea;--dim:#aaa298;--card:#23211e;--line:#3a3630;--soft:#2c2925;--chip:#23211e;--accent:#fb923c;--accent-ink:#fdba74;--strike:#aaa298;--shadow:0 1px 0 rgba(0,0,0,.2);color-scheme:dark}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 var(--sans);overflow-wrap:anywhere}
.wrap{max-width:1160px;margin:0 auto;padding:0 16px}
.sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:16px;top:-48px;background:var(--fg);color:var(--bg);padding:8px 12px;border-radius:8px;z-index:9}
.skip:focus{top:8px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button,input,select{font:inherit;color:inherit}
button{cursor:pointer}
.i{flex:none}
.top{display:grid;grid-template-columns:1fr auto;gap:14px 24px;align-items:end;padding:36px 0 18px;border-bottom:1px solid var(--line);margin-bottom:28px}
.title h1{margin:0;font:600 clamp(28px,4vw,38px)/1.1 var(--serif);letter-spacing:-.01em;display:flex;align-items:center;gap:12px}
.dot{width:14px;height:14px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 22%,transparent);flex:none}
.stats{margin:8px 0 0;color:var(--dim);font-size:14px}
.stats b{color:var(--fg);font-weight:600}
.tools{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.btn,.ghost{display:inline-flex;align-items:center;gap:7px;border-radius:9px;font-size:14px;line-height:1;min-height:36px;padding:0 12px;white-space:nowrap}
.btn{border:1px solid var(--line);background:var(--card);box-shadow:var(--shadow)}
.btn:hover{border-color:var(--dim)}
.ghost{border:1px solid transparent;background:none;color:var(--dim)}
.ghost:hover{color:var(--fg);background:var(--soft)}
.search{grid-column:1/-1;position:relative}
.search .i{position:absolute;left:13px;top:50%;transform:translateY(-50%);color:var(--dim);width:18px;height:18px}
.search input{width:100%;height:46px;padding:0 44px 0 40px;border:1px solid var(--line);border-radius:12px;background:var(--card);box-shadow:var(--shadow);font-size:16px}
.search input::placeholder{color:var(--dim);opacity:1}
.search input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
.search input::-webkit-search-cancel-button{cursor:pointer}
kbd{position:absolute;right:12px;top:50%;transform:translateY(-50%);font:12px/1 var(--sans);color:var(--dim);border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;padding:3px 6px;background:var(--bg)}
.search input:focus~kbd{display:none}
.filters,.pick{grid-column:1/-1}
.fbody{display:grid;gap:8px}
.filters summary{display:none}
#fcount{margin-left:auto;font-size:12px;font-weight:600;color:var(--accent-ink)}
.frow{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.fl{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);min-width:64px}
.chip{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 10px;border:1px solid var(--line);border-radius:999px;background:var(--chip);font-size:14px}
.chip:hover{border-color:var(--dim)}
.chip[aria-pressed=true]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.chip .ct{font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
.chip[aria-pressed=true] .ct{color:inherit;opacity:.75}
.sw{width:14px;height:14px;border-radius:4px;border:1px solid rgba(0,0,0,.12)}
.st-underline{text-decoration:underline 2px var(--underline);text-underline-offset:3px}
.st-strike{text-decoration:line-through 2px var(--strike)}
.chip[aria-pressed=true] .st{text-decoration-color:currentColor}
.pick{display:none}
.pick select{min-height:40px;flex:1;min-width:0;padding:0 10px;border:1px solid var(--line);border-radius:9px;background:var(--card)}
.statusrow{grid-column:1/-1;display:flex;align-items:center;gap:12px;min-height:32px}
#count{margin:0;font-size:14px;color:var(--dim)}
.layout{display:grid;grid-template-columns:232px minmax(0,1fr);gap:40px;align-items:start}
.layout.solo{grid-template-columns:minmax(0,1fr)}
.side{position:sticky;top:16px;max-height:calc(100vh - 32px);overflow:auto;padding-bottom:16px}
.sideh{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);margin:4px 0 10px}
.side ul{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.sbtn{display:grid;width:100%;text-align:left;gap:1px;padding:8px 10px 8px 12px;border:0;border-left:3px solid transparent;border-radius:0 8px 8px 0;background:none}
.sbtn:hover{background:var(--soft)}
.sbtn[aria-current=true]{background:var(--soft);border-left-color:var(--accent)}
.sp{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm{font-size:12px;color:var(--dim)}
.sbtn.zero{opacity:.45}
main{min-width:0;max-width:780px;outline:none}
.session{margin:0 0 48px}
.shead{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px;margin:0 0 18px;padding-bottom:10px;border-bottom:1px dashed var(--line)}
.shead h2{margin:0;font:600 22px/1.25 var(--serif)}
.smeta{margin:0;color:var(--dim);font-size:13px}
.reply{margin:0 0 26px}
.ctx{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;margin:0 0 10px;color:var(--dim);font-size:14px}
.ctx .k{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.ctx q{font:italic 15px/1.45 var(--serif);quotes:'“' '”'}
.pin{font-size:12px;font-weight:600;color:var(--accent-ink);border:1px solid currentColor;border-radius:999px;padding:1px 8px}
.card{position:relative;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--cc,var(--yellow));border-radius:10px;padding:16px 18px 8px;margin:0 0 12px;box-shadow:var(--shadow)}
.c-yellow{--cc:#f5c84c}.c-green{--cc:#5fd08a}.c-pink{--cc:#f29ac6}.c-blue{--cc:#7fb2f0}.c-orange{--cc:#f7a35c}.c-underline{--cc:var(--underline)}.c-strike{--cc:var(--strike)}
.quote{margin:0;font:18px/1.65 var(--serif)}
.m{color:#1c1917;padding:.08em .22em;border-radius:3px;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.m-yellow{background:var(--yellow)}.m-green{background:var(--green)}.m-pink{background:var(--pink)}.m-blue{background:var(--blue)}.m-orange{background:var(--orange)}
.m-underline,.m-strike{background:none;color:inherit;padding:0}
.m-underline{text-decoration:underline 2px var(--underline);text-underline-offset:4px}
.m-strike{text-decoration:line-through 2px var(--strike)}
.note{margin:12px 0 0;padding:9px 12px;background:var(--soft);border-radius:8px;font-size:15px;line-height:1.55}
.tag{display:inline;font:600 13px/1 var(--sans);color:var(--accent-ink);background:color-mix(in srgb,var(--accent) 10%,transparent);border:1px solid color-mix(in srgb,var(--accent) 40%,transparent);border-radius:999px;padding:3px 8px;margin:0 1px;vertical-align:1px}
button.tag:hover{background:color-mix(in srgb,var(--accent) 20%,transparent)}
.foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;font-size:13px;color:var(--dim)}
.foot .ghost{min-height:32px;padding:0 8px;font-size:13px}
.hit{background:var(--hit);color:#fff;border-radius:2px;padding:0 1px}
.gwrap{margin:4px 0 26px}
.gh{margin:0 0 10px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
.sk{margin:0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px;box-shadow:var(--shadow)}
.paper{background:#fff;border-radius:6px;border:1px solid #ece6d8;overflow:hidden;line-height:0}
.paper svg{width:100%;height:auto;max-height:280px}
.sk figcaption{display:grid;gap:2px;padding:8px 4px 2px;font-size:13px;color:var(--dim)}
.sk q{font:italic 14px/1.4 var(--serif);color:var(--fg)}
.none,.empty{text-align:left;padding:28px;border:1px dashed var(--line);border-radius:14px;background:var(--card)}
.none h2,.empty h2{margin:0 0 6px;font:600 22px/1.3 var(--serif)}
.empty{max-width:640px}
.empty ol{margin:14px 0;padding-left:22px;display:grid;gap:8px}
.demo{font:19px/1.6 var(--serif);margin:0 0 20px;padding:0 0 18px;border-bottom:1px dashed var(--line)}
.dim{color:var(--dim)}
.end{margin:24px 0 0;padding:20px 0 40px;border-top:1px solid var(--line);color:var(--dim);font-size:13px}
@media (max-width:899px){
.layout{grid-template-columns:minmax(0,1fr)}
.side{display:none}
.pick{display:flex}
}
@media (max-width:640px){
.top{grid-template-columns:minmax(0,1fr);padding-top:24px;margin-bottom:20px}
.tools{justify-content:flex-start;display:grid;grid-template-columns:1fr 1fr}
.tools .btn{justify-content:center}
.fl{min-width:0;width:100%}
.filters summary{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 12px;border:1px solid var(--line);border-radius:9px;background:var(--card);font-size:14px;font-weight:600;cursor:pointer;list-style:none}
.filters summary::-webkit-details-marker{display:none}
.filters summary::after{content:'';width:7px;height:7px;border:solid var(--dim);border-width:0 2px 2px 0;transform:rotate(45deg);margin:-3px 2px 0 8px}
.filters[open] summary::after{transform:rotate(-135deg);margin-top:3px}
.filters[open] summary{margin-bottom:10px}
.pick .fl{width:auto}
kbd{display:none}
.quote{font-size:17px}
.card{padding:14px 14px 6px}
.shead h2{font-size:20px}
.gallery{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}
}
@media print{
:root,:root[data-theme=dark],:root[data-theme=light],:root:not([data-theme=light]){--bg:#fff;--fg:#000;--dim:#444;--card:#fff;--line:#bbb;--soft:#f3f3f3;--accent-ink:#000;--shadow:none;color-scheme:light}
body{background:#fff;color:#000;font-size:11pt}
.tools,.search,.filters,.pick,.statusrow,.side,.copy,.skip,.none,#status,.end{display:none!important}
.wrap{max-width:none;padding:0}
.top{margin-bottom:16px;padding-top:0}
.layout{display:block}
main{max-width:none}
.session+.session{break-before:page}
.card,.sk,.ctx{break-inside:avoid}
.card{box-shadow:none;border-left-width:3px}
.hit{background:none;color:inherit;padding:0}
.tag{border-color:#999;background:none}
*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
`

// The page script. Plain ES2017, no template literals (this file embeds it in one).
const JS = String.raw`
(function(){
var d=document,root=d.documentElement,K='margin-theme';
function $$(s,el){return [].slice.call((el||d).querySelectorAll(s))}
function fmt(ms,o){try{return new Date(ms).toLocaleString(undefined,o)}catch(e){return ''}}
var DAY={weekday:'short',year:'numeric',month:'short',day:'numeric'};
var AT={month:'short',day:'numeric',hour:'numeric',minute:'2-digit'};
$$('time[data-at]').forEach(function(t){var ms=+t.getAttribute('data-at');t.textContent=fmt(ms,AT);t.title=fmt(ms,{dateStyle:'full',timeStyle:'long'})});
$$('time[data-day]').forEach(function(t){t.textContent=fmt(+t.getAttribute('data-day'),DAY)});
var YEAR=new Date().getFullYear();
$$('time[data-short]').forEach(function(t){var ms=+t.getAttribute('data-short');t.textContent=fmt(ms,new Date(ms).getFullYear()===YEAR?{weekday:'short',month:'short',day:'numeric'}:{month:'short',day:'numeric',year:'numeric'})});
$$('#sess option[data-day]').forEach(function(o){o.textContent=o.getAttribute('data-label')+' · '+fmt(+o.getAttribute('data-day'),{month:'short',day:'numeric',year:'numeric'})+' ('+o.getAttribute('data-n')+')'});

var status=d.getElementById('status');
function say(t){if(status){status.textContent='';setTimeout(function(){status.textContent=t},30)}}

// Theme: follows the system until you pick one; the pick is remembered.
var mq=window.matchMedia?matchMedia('(prefers-color-scheme: dark)'):null;
function theme(){return root.getAttribute('data-theme')||(mq&&mq.matches?'dark':'light')}
var tb=d.getElementById('theme');
function paintTheme(){if(!tb)return;var dark=theme()==='dark';tb.querySelector('.lbl').textContent=dark?'Light':'Dark';tb.setAttribute('aria-label',dark?'Switch to light theme':'Switch to dark theme')}
paintTheme();if(mq&&mq.addEventListener)mq.addEventListener('change',paintTheme);

// Filters
var st={q:'',c:{},t:{},p:{},s:'',note:false};
var cards=$$('.card'),sks=$$('.sk'),secs=$$('.session'),replies=$$('.reply'),gws=$$('.gwrap'),sbtns=$$('.sbtn'),chips=$$('.chip');
var q=d.getElementById('q'),sel=d.getElementById('sess'),count=d.getElementById('count'),clear=d.getElementById('clear'),none=d.getElementById('none');
var TOTAL=+d.body.getAttribute('data-total'),SK=+d.body.getAttribute('data-sk'),HINT=count?count.textContent:'';
var fbox=d.getElementById('fbox'),fcount=d.getElementById('fcount');
// Phones start with the filter chips folded away; wide screens always show them.
var narrow=window.matchMedia?matchMedia('(max-width:640px)'):null;
if(fbox&&narrow){if(narrow.matches)fbox.open=false;if(narrow.addEventListener)narrow.addEventListener('change',function(){if(!narrow.matches)fbox.open=true})}
function has(list,v){return (' '+list+' ').indexOf(' '+v+' ')>-1}
function pl(n,a,b){return n+' '+(n===1?a:b)}
function rx(terms){return terms.length?new RegExp(terms.map(function(w){return w.replace(/[.*+?^$(){}|[\]\\]/g,'\\$&')}).join('|'),'gi'):null}
function wrap(el,re){
  var w=d.createTreeWalker(el,NodeFilter.SHOW_TEXT),ns=[],n;
  while((n=w.nextNode()))ns.push(n);
  ns.forEach(function(t){
    var s=t.nodeValue,i=0,m,f=null;re.lastIndex=0;
    while((m=re.exec(s))){
      if(!m[0]){re.lastIndex++;continue}
      f=f||d.createDocumentFragment();
      if(m.index>i)f.appendChild(d.createTextNode(s.slice(i,m.index)));
      var k=d.createElement('mark');k.className='hit';k.textContent=m[0];f.appendChild(k);
      i=m.index+m[0].length;
    }
    if(f){if(i<s.length)f.appendChild(d.createTextNode(s.slice(i)));t.parentNode.replaceChild(f,t)}
  });
}
function hits(c,re){$$('.hl',c).forEach(function(el){
  if(el._o===undefined)el._o=el.innerHTML;else if(el._m){el.innerHTML=el._o;el._m=false}
  if(re){wrap(el,re);el._m=true}
})}
function apply(){
  var terms=st.q.toLowerCase().split(/\s+/).filter(Boolean),re=rx(terms);
  var cs=Object.keys(st.c),ts=Object.keys(st.t),ps=Object.keys(st.p);
  var n=0,k=0,per={};
  function okText(a){return terms.every(function(w){return a.indexOf(w)>-1})}
  cards.forEach(function(c){
    var a=c.dataset;
    var base=(!cs.length||st.c[a.c])&&(!ps.length||st.p[a.p])&&(!st.note||a.note==='1')&&(!ts.length||ts.some(function(t){return has(a.tags,t)}))&&okText(a.hay);
    if(base)per[a.s]=(per[a.s]||0)+1;
    var ok=base&&(!st.s||a.s===st.s);
    c.hidden=!ok;if(ok)n++;hits(c,ok?re:null);
  });
  var hlOnly=cs.length||ts.length||st.note;
  sks.forEach(function(f){
    var a=f.dataset,base=!hlOnly&&(!ps.length||st.p[a.p])&&okText(a.hay);
    if(base)per[a.s]=(per[a.s]||0)+1;
    var ok=base&&(!st.s||a.s===st.s);
    f.hidden=!ok;if(ok)k++;
  });
  replies.forEach(function(r){r.hidden=!r.querySelector('.card:not([hidden])')});
  gws.forEach(function(g){g.hidden=!g.querySelector('.sk:not([hidden])')});
  secs.forEach(function(s){s.hidden=!s.querySelector('.card:not([hidden]),.sk:not([hidden])')});
  sbtns.forEach(function(b){var v=b.getAttribute('data-sess');b.setAttribute('aria-current',v===st.s?'true':'false');b.classList.toggle('zero',!!v&&!per[v])});
  if(sel)sel.value=st.s;
  chips.forEach(function(ch){var f=ch.getAttribute('data-f'),v=ch.getAttribute('data-v');ch.setAttribute('aria-pressed',String(f==='note'?st.note:!!st[f][v]))});
  var active=!!(terms.length||cs.length||ts.length||ps.length||st.note||st.s);
  if(count)count.textContent=active?(n+' of '+pl(TOTAL,'highlight','highlights')+(SK?' · '+k+' of '+pl(SK,'sketch','sketches'):'')+' shown'):HINT;
  if(clear)clear.hidden=!active;
  var nf=cs.length+ts.length+ps.length+(st.note?1:0);if(fcount)fcount.textContent=nf?nf+' on':'';
  if(none)none.hidden=n+k>0;
}
function reset(){st={q:'',c:{},t:{},p:{},s:'',note:false};if(q)q.value='';apply()}
function flip(o,v){if(o[v])delete o[v];else o[v]=true}
function toTop(){var m=d.getElementById('results');if(m&&m.getBoundingClientRect().top<0)m.scrollIntoView({block:'start'})}

// Markdown of what is visible
function visibleMd(){
  var out=['# Margin notebook',''];
  secs.forEach(function(s){
    if(s.hidden)return;
    out.push('## '+s.getAttribute('data-title'),'');
    $$('.reply',s).forEach(function(r){
      if(r.hidden)return;
      var cx=r.getAttribute('data-ctx');if(cx)out.push('*'+cx+'*','');
      $$('.card',r).forEach(function(c){if(!c.hidden)out.push(c.getAttribute('data-md'),'')});
    });
    $$('.sk',s).forEach(function(f){if(!f.hidden)out.push('![sketch](sketches/'+encodeURIComponent(f.getAttribute('data-id'))+'.svg)','')});
  });
  return out.join('\n');
}
function fallback(txt){var ta=d.createElement('textarea');ta.value=txt;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.top='0';ta.style.opacity='0';d.body.appendChild(ta);ta.select();var ok=false;try{ok=d.execCommand('copy')}catch(e){}d.body.removeChild(ta);return ok}
function copy(txt,btn,what){
  function done(ok){
    say(ok?'Copied '+what+' as Markdown':'Could not copy. Try Download instead.');
    var l=btn&&btn.querySelector('.lbl');if(!l)return;
    if(!l.hasAttribute('data-l'))l.setAttribute('data-l',l.textContent);
    l.textContent=ok?'Copied':'Copy failed';clearTimeout(btn._t);btn._t=setTimeout(function(){l.textContent=l.getAttribute('data-l')},1600);
  }
  try{if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(function(){done(true)},function(){done(fallback(txt))});return}}catch(e){}
  done(fallback(txt));
}
function download(){
  var b=new Blob([visibleMd()],{type:'text/markdown;charset=utf-8'}),u=URL.createObjectURL(b),a=d.createElement('a');
  a.href=u;a.download='margin-notebook.md';d.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(u)},2000);say('Downloading margin-notebook.md');
}

d.addEventListener('click',function(e){
  var b=e.target.closest&&e.target.closest('button');if(!b)return;
  var cl=b.classList;
  if(cl.contains('chip')){var f=b.getAttribute('data-f');if(f==='note')st.note=!st.note;else flip(st[f],b.getAttribute('data-v'));apply();return}
  if(cl.contains('tag')){flip(st.t,b.getAttribute('data-tag'));apply();toTop();return}
  if(cl.contains('sbtn')){st.s=b.getAttribute('data-sess');apply();toTop();return}
  if(cl.contains('copy')){copy(b.closest('.card').getAttribute('data-md'),b,'highlight');return}
  switch(b.id){
    case 'copyall':copy(visibleMd(),b,'everything visible');break;
    case 'dl':download();break;
    case 'print':window.print();break;
    case 'clear':case 'clear2':reset();if(q)q.focus();break;
    case 'theme':var t=theme()==='dark'?'light':'dark';root.setAttribute('data-theme',t);try{localStorage.setItem(K,t)}catch(err){}paintTheme();break;
  }
});
if(sel)sel.addEventListener('change',function(){st.s=sel.value;apply()});
if(q){
  q.addEventListener('input',function(){st.q=q.value;apply()});
  q.addEventListener('keydown',function(e){if(e.key==='Escape'&&q.value){q.value='';st.q='';apply()}});
}
d.addEventListener('keydown',function(e){
  if(e.key!=='/'||!q||e.ctrlKey||e.metaKey||e.altKey)return;
  var t=e.target,n=t&&t.tagName;
  if(n==='INPUT'||n==='TEXTAREA'||n==='SELECT'||(t&&t.isContentEditable))return;
  e.preventDefault();q.focus();q.select();
});
if(cards.length||sks.length)apply();
})();
`
