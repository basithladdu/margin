// Builds the notebook files: index.html to browse, notebook.md for any notes
// app (Obsidian, Logseq), one .svg per sketch.

import type { Highlight, MarksData, Sketch } from '../types'
import { sketchSvg } from './ink'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : w.endsWith('h') ? 'es' : 's'}`
const time = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

type Group = { key: string; where: string; first: number; highlights: Highlight[]; sketches: Sketch[] }

function groups(d: MarksData): Group[] {
  const by = new Map<string, Group>()
  const get = (session: string | undefined, where: string | undefined, at: number) => {
    const key = session ?? `day-${day(at)}`
    let g = by.get(key)
    if (!g) {
      g = { key, where: where ?? 'Claude Code', first: at, highlights: [], sketches: [] }
      by.set(key, g)
    }
    g.first = Math.min(g.first, at)
    return g
  }
  for (const list of Object.values(d.highlights)) for (const h of list) get(h.session, h.where, h.at).highlights.push(h)
  for (const s of d.sketches) get(s.session, s.where, s.at).sketches.push(s)
  for (const g of by.values()) {
    g.highlights.sort((a, b) => a.at - b.at)
    g.sketches.sort((a, b) => a.at - b.at)
  }
  return [...by.values()].sort((a, b) => b.first - a.first)
}

export function notebookMarkdown(d: MarksData): string {
  const out = ['# Margin notebook', '', 'Highlights and sketches from Claude Code, newest session first.', '']
  for (const g of groups(d)) {
    out.push(`## ${g.where} · ${day(g.first)}`, '')
    for (const h of g.highlights) {
      out.push(`> ${h.text.replace(/\n/g, '\n> ')}`)
      out.push(`> — ${h.color}, ${day(h.at)}`)
      if (h.note) out.push('', `**Note:** ${h.note}`)
      out.push('')
    }
    for (const s of g.sketches) out.push(`![sketch](sketches/${s.id}.svg)`, '')
  }
  return out.join('\n')
}

export function notebookHtml(d: MarksData): string {
  const sections = groups(d)
    .map(g => {
      const items = g.highlights
        .map(
          h => `<article class="card">
  <p class="quote"><mark class="${h.color}">${esc(h.text).replace(/\n/g, '<br>')}</mark></p>
  ${h.note ? `<p class="note">${esc(h.note)}</p>` : ''}
  <p class="meta"><time data-at="${h.at}">${time(h.at)}</time></p>
</article>`,
        )
        .join('\n')
      const sketches = g.sketches
        .map(s => `<figure class="card sketch">${sketchSvg(s, { ink: 'currentColor' })}<figcaption class="meta"><time data-at="${s.at}">${time(s.at)}</time></figcaption></figure>`)
        .join('\n')
      return `<section data-text="${esc(
        (g.where + ' ' + g.highlights.map(h => h.text + ' ' + (h.note ?? '')).join(' ')).toLowerCase(),
      )}">
<h2>${esc(g.where)} <span><time data-day="${g.first}">${day(g.first)}</time> · ${plural(g.highlights.length, 'highlight')}${g.sketches.length ? ` · ${plural(g.sketches.length, 'sketch')}` : ''}</span></h2>
<div class="grid">${items}${sketches}</div>
</section>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Margin notebook</title>
<style>
:root{--bg:#faf8f3;--fg:#1c1917;--dim:#78716c;--card:#fff;--line:#e7e2d6;--y:#fde68a;--g:#bbf7d0;--p:#fbcfe8}
@media (prefers-color-scheme:dark){:root{--bg:#1a1917;--fg:#f5f2ea;--dim:#a8a29e;--card:#24221f;--line:#36332e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 Georgia,'Iowan Old Style',serif}
header{max-width:960px;margin:0 auto;padding:40px 16px 8px}h1{font-size:34px;margin:0}header p{color:var(--dim);margin:4px 0 16px;font-family:system-ui,sans-serif;font-size:14px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:15px system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:8px 16px 64px}h2{font:600 18px system-ui,sans-serif;margin:32px 0 12px}h2 span{color:var(--dim);font-weight:400;font-size:14px;margin-left:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0}
.quote{margin:0}mark{color:#1c1917;padding:1px 3px;border-radius:3px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
mark.yellow{background:var(--y)}mark.green{background:var(--g)}mark.pink{background:var(--p)}
.note{margin:10px 0 0;padding-left:10px;border-left:3px solid var(--line);font-style:italic}
.meta{margin:8px 0 0;color:var(--dim);font:12px system-ui,sans-serif}.sketch svg{width:100%;height:auto;color:var(--fg)}
.empty{color:var(--dim);font-family:system-ui,sans-serif}
</style></head><body>
<header><h1>Margin notebook</h1><p>Your highlights, notes and sketches from Claude Code. Kept on this computer only.</p>
<input id="q" type="search" placeholder="Search highlights and notes"></header>
<main>${sections || '<p class="empty">Nothing here yet. Highlight something in Claude Code and it shows up here.</p>'}</main>
<script>
document.querySelectorAll('time[data-at]').forEach(t=>{t.textContent=new Date(+t.dataset.at).toLocaleString([], {dateStyle:'medium',timeStyle:'short'})});
document.querySelectorAll('time[data-day]').forEach(t=>{t.textContent=new Date(+t.dataset.day).toLocaleDateString([], {dateStyle:'medium'})});
const q=document.getElementById('q');q.addEventListener('input',()=>{const v=q.value.toLowerCase();
document.querySelectorAll('section').forEach(s=>{s.style.display=!v||s.dataset.text.includes(v)?'':'none'})})
</script></body></html>`
}
