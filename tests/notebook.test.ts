import { expect, test } from 'claude-code/testing'
import { notebookHtml, notebookMarkdown } from '../hooks/notebook'
import type { Highlight, MarkColor, MarksData } from '../types'

const T0 = Date.UTC(2026, 10, 17, 9, 0)

const mk = (id: string, requestId: string, color: MarkColor, text: string, min: number, more: Partial<Highlight> = {}): Highlight => ({
  id,
  requestId,
  color,
  text,
  at: T0 + min * 60_000,
  ...more,
})

const older = { session: 'old', where: 'margin' }
const newer = { session: 'new', where: 'duoseat' }

const data: MarksData = {
  highlights: {
    r1: [
      mk('1', 'r1', 'yellow', 'First yellow words', 1, { ...older, context: 'How the export works', note: 'Keep this #idea' }),
      mk('2', 'r1', 'underline', 'an underlined bit', 2, { ...older, context: 'How the export works' }),
      mk('3', 'r1', 'strike', 'a struck idea', 3, { ...older, note: 'nope #wrong' }),
    ],
    r2: [
      mk('4', 'r2', 'green', 'Escape <script>alert("x")</script> & co', 4, { ...older, context: 'Security <b>notes</b>', note: '<img src=x onerror=alert(1)> #todo' }),
      mk('5', 'r2', 'pink', 'pink one', 5, older),
      mk('6', 'r2', 'blue', 'blue one', 6, older),
    ],
    r3: [mk('7', 'r3', 'orange', 'Newest session text', 60 * 24, { ...newer, context: 'Sharing a screen', note: 'Ask #todo and #Question; issue #12 is not a tag' })],
  },
  markers: ['r2'],
  sketches: [{ id: 'sk1', strokes: [[2, 2, 10, 8, 20, 4]], w: 30, h: 12, at: T0 + 10 * 60_000, ...older, requestId: 'r2', context: 'Security notes' }],
}

test('the notebook page lists every highlight, newest session first, with filters and tools', async () => {
  const html = notebookHtml(data)
  expect(html.startsWith('<!doctype html>')).toBe(true)
  // Self-contained: nothing loaded from the network.
  expect(/<(script|link)[^>]+(src|href)=["']https?:/i.test(html)).toBe(false)
  expect(html).toContain('<b>7</b> highlights')
  expect(html).toContain('<b>4</b> notes')
  expect(html).toContain('<b>1</b> sketch')
  expect(html).toContain('<b>2</b> sessions')
  // Newest session first.
  expect(html.indexOf('Newest session text')).toBeLessThan(html.indexOf('First yellow words'))
  // Inside a session, in the order they were made.
  expect(html.indexOf('First yellow words')).toBeLessThan(html.indexOf('pink one'))
  for (const c of ['yellow', 'green', 'pink', 'blue', 'orange', 'underline', 'strike']) {
    expect(html).toContain(`class="m m-${c} hl"`)
    expect(html).toContain(`data-v="${c}"`)
  }
  // Tags from notes become filter chips and in-note buttons, lowercased; "#12" is not a tag.
  expect(html).toContain('data-f="t" data-v="todo"')
  expect(html).toContain('data-f="t" data-v="question"')
  expect(html).toContain('data-tag="idea"')
  expect(html).not.toContain('data-v="12"')
  // Reply context, read marker, sketch, toolbar, search.
  expect(html).toContain('How the export works')
  expect(html).toContain('Read up to here')
  expect(html).toContain('<svg')
  expect(html).toContain('id="q"')
  for (const id of ['copyall', 'dl', 'theme', 'print']) expect(html).toContain(`id="${id}"`)
  expect(html).toContain('@media print')
  expect(html).toContain('data-at="')
})

test('model and note text is escaped everywhere in the page', async () => {
  const html = notebookHtml(data)
  expect(html).not.toContain('<script>alert')
  expect(html).not.toContain('<img src=x')
  expect(html).not.toContain('<b>notes</b>')
  expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co')
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  // The only script tags are the page's own two.
  expect(html.match(/<script>/g)?.length).toBe(2)
})

test('an empty notebook explains how to make the first highlight', async () => {
  const html = notebookHtml({ highlights: {}, markers: [], sketches: [] })
  expect(html).toContain('Your notebook is empty')
  expect(html).toContain('Select some text')
  expect(html).toContain('Press a colour')
  expect(html).not.toContain('id="q"')
  expect(notebookMarkdown({ highlights: {}, markers: [], sketches: [] })).toContain('Nothing here yet')
})

test('the markdown export has one section per session with quotes, styles, notes and sketches', async () => {
  const md = notebookMarkdown(data)
  expect(md.startsWith('# Margin notebook')).toBe(true)
  expect(md).toContain('## duoseat · 2026-11-18')
  expect(md).toContain('## margin · 2026-11-17')
  expect(md.indexOf('## duoseat')).toBeLessThan(md.indexOf('## margin'))
  expect(md).toContain('*From the reply: “How the export works…”*')
  expect(md).toContain('> First yellow words')
  expect(md).toContain('> — yellow highlight')
  expect(md).toContain('> — underlined')
  expect(md).toContain('> — struck through')
  expect(md).toContain('Keep this #idea')
  expect(md).toContain('read up to here')
  expect(md).toContain('![sketch](sketches/sk1.svg)')
  // Raw HTML in a note or quote stays text in notes apps.
  expect(md).toContain('Escape \\<script>')
  expect(md).not.toMatch(/(^|[^\\])<img/)
})
