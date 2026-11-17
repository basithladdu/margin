// Pure text logic: split a reply into blocks, turn markdown into the text a
// reader sees, and find a selection inside it. No engine calls here.

import type { Highlight, MarkColor } from '../types'

export type Segment = { text: string; color?: MarkColor }

export type Piece =
  | { kind: 'md'; md: string }
  | { kind: 'marked'; segments: Segment[]; isCode: boolean; notes: Highlight[] }

type Block = { md: string; isCode: boolean; plain: string }

const FENCE = /^\s*(```|~~~)/

/** Splits markdown on blank lines, keeping fenced code blocks whole. */
export function splitBlocks(md: string): { md: string; isCode: boolean }[] {
  const out: { md: string; isCode: boolean }[] = []
  let lines: string[] = []
  let inFence = false
  let isCode = false
  const flush = () => {
    if (lines.length && lines.some(l => l.trim() !== '')) {
      out.push({ md: lines.join('\n'), isCode })
    }
    lines = []
    isCode = false
  }
  for (const line of md.split('\n')) {
    if (FENCE.test(line)) {
      if (!inFence) {
        flush()
        inFence = true
        isCode = true
        lines.push(line)
      } else {
        lines.push(line)
        inFence = false
        flush()
      }
      continue
    }
    if (inFence) {
      lines.push(line)
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    lines.push(line)
  }
  flush()
  return out
}

/** What a reader sees of a block: markdown marks taken out. */
export function toPlain(md: string, isCode: boolean): string {
  if (isCode) {
    return md
      .split('\n')
      .filter(l => !FENCE.test(l))
      .join('\n')
  }
  return md
    .split('\n')
    .map(line =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^(\s*)[-*+]\s+/, '$1• ')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\*\*|__|\*|`/g, ''),
    )
    .join('\n')
}

/** Letters and digits only, lowercased, with a map back to `s`. */
function squeeze(s: string): { text: string; map: number[] } {
  let text = ''
  const map: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (/[\p{L}\p{N}]/u.test(c)) {
      text += c.toLowerCase()
      map.push(i)
    }
  }
  return { text, map }
}

/**
 * Finds `needle` (text as the reader selected it) in `hay` (plain text).
 * Returns [start, end) in `hay`, or null. Falls back to matching the head and
 * the tail when list numbers or other marks sit between.
 */
export function locate(hay: string, needle: string): [number, number] | null {
  const h = squeeze(hay)
  const n = squeeze(needle).text
  if (n.length === 0) return null
  let at = h.text.indexOf(n)
  if (at >= 0) return [h.map[at]!, h.map[at + n.length - 1]! + 1]
  if (n.length < 30) return null
  const head = n.slice(0, 20)
  const tail = n.slice(-20)
  at = h.text.indexOf(head)
  while (at >= 0) {
    const end = h.text.indexOf(tail, at + head.length)
    if (end >= 0 && end + tail.length - at <= n.length * 1.5 + 20) {
      return [h.map[at]!, h.map[end + tail.length - 1]! + 1]
    }
    at = h.text.indexOf(head, at + 1)
  }
  return null
}

/** True when `needle` can be found in this reply block's markdown. */
export function blockHas(md: string, needle: string): boolean {
  return locate(plainOf(md), needle) !== null
}

function blocksOf(md: string): Block[] {
  return splitBlocks(md).map(b => ({ ...b, plain: toPlain(b.md, b.isCode) }))
}

function plainOf(md: string): string {
  return blocksOf(md)
    .map(b => b.plain)
    .join('\n\n')
}

/**
 * Lays out a reply block with its highlights: untouched blocks stay markdown,
 * blocks a highlight touches become coloured runs of plain text.
 */
export function layout(md: string, highlights: readonly Highlight[]): Piece[] {
  const blocks = blocksOf(md)
  const starts: number[] = []
  let pos = 0
  for (const b of blocks) {
    starts.push(pos)
    pos += b.plain.length + 2
  }
  const full = blocks.map(b => b.plain).join('\n\n')

  type Range = { s: number; e: number; h: Highlight }
  const ranges: Range[] = []
  for (const h of highlights) {
    const r = locate(full, h.text)
    if (r) ranges.push({ s: r[0], e: r[1], h })
  }

  return blocks.map((b, i): Piece => {
    const bs = starts[i]!
    const be = bs + b.plain.length
    const mine = ranges
      .filter(r => r.s < be && r.e > bs)
      .map(r => ({ s: Math.max(r.s, bs) - bs, e: Math.min(r.e, be) - bs, h: r.h }))
    if (mine.length === 0) return { kind: 'md', md: b.md }

    // Colour each character by the latest highlight covering it.
    const colors: (MarkColor | undefined)[] = new Array(b.plain.length).fill(undefined)
    for (const r of [...mine].sort((a, c) => a.h.at - c.h.at)) {
      for (let k = r.s; k < r.e; k++) colors[k] = r.h.color
    }
    const segments: Segment[] = []
    for (let k = 0; k < b.plain.length; k++) {
      const last = segments[segments.length - 1]
      if (last && last.color === colors[k]) last.text += b.plain[k]
      else segments.push({ text: b.plain[k]!, color: colors[k] })
    }
    // A note shows under the block where its highlight ends.
    const notes = ranges.filter(r => r.h.note && r.e > bs && r.e <= be).map(r => r.h)
    return { kind: 'marked', segments, isCode: b.isCode, notes }
  })
}

/**
 * Splits a selection that spans several reply blocks into one piece per block.
 * `texts` is every known block, in transcript order.
 */
export function assign(
  selection: string,
  texts: readonly { id: string; md: string }[],
): { id: string; text: string }[] {
  const whole = texts.filter(t => blockHas(t.md, selection))
  if (whole.length) return [{ id: whole[whole.length - 1]!.id, text: selection }]

  const out: { id: string; text: string }[] = []
  for (const line of selection.split('\n')) {
    if (squeeze(line).text.length < 3) continue
    const hit = texts.filter(t => blockHas(t.md, line)).pop()
    if (!hit) continue
    const prev = out[out.length - 1]
    if (prev && prev.id === hit.id && blockHas(hit.md, prev.text + '\n' + line)) {
      prev.text += '\n' + line
    } else {
      out.push({ id: hit.id, text: line })
    }
  }
  return out
}

/**
 * The highlights of one reply block that overlap `selection`: what Erase
 * takes off. A highlight counts when its text and the selection share a range.
 */
export function overlapping(md: string, highlights: readonly Highlight[], selection: string): Highlight[] {
  const full = plainOf(md)
  const sel = locate(full, selection)
  if (!sel) return highlights.filter(h => squeeze(selection).text.includes(squeeze(h.text).text))
  return highlights.filter(h => {
    const r = locate(full, h.text)
    return r !== null && r[0] < sel[1] && r[1] > sel[0]
  })
}

/** The opening words of a reply, for a one-line label. */
export function firstLine(md: string, n = 80): string {
  const plain = plainOf(md).replace(/\s+/g, ' ').trim()
  return plain.length > n ? plain.slice(0, n - 1) + '…' : plain
}
