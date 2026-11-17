// Turns sketch strokes into a smooth SVG with perfect-freehand (MIT, Steve Ruiz).

import { getStroke } from './vendor/perfect-freehand/getStroke'
import type { Sketch } from '../types'

const SCALE = 6 // pixels per braille dot
const SIZE = 9 // pen diameter in pixels
const PAD = 10 // room around the drawing, in pixels
const MIN_W = 120 // a lone dot still gets a little paper around it
const MIN_H = 60
/** The pad's first ink. A caller's `opts.ink` stands in for it (a theme's ink). */
export const DEFAULT_INK = '#1c1917'

const n = (v: number) => (Math.round(v * 10) / 10).toString()

/** Only a hex colour or currentColor reaches the markup. */
function safeColor(c: unknown): string | undefined {
  return typeof c === 'string' && (/^#[0-9a-fA-F]{3,8}$/.test(c) || c === 'currentColor') ? c : undefined
}

function pathFromOutline(points: number[][]): string {
  if (points.length < 3) return ''
  const p = (i: number) => points[i % points.length]!
  let d = `M${n(p(0)[0]!)},${n(p(0)[1]!)} Q`
  for (let i = 0; i < points.length; i++) {
    const a = p(i)
    const b = p(i + 1)
    d += `${n(a[0]!)},${n(a[1]!)} ${n((a[0]! + b[0]!) / 2)},${n((a[1]! + b[1]!) / 2)} `
  }
  return d + 'Z'
}

export function sketchSvg(s: Sketch, opts: { ink?: string; paper?: string } = {}): string {
  const fallback = safeColor(opts.ink) ?? DEFAULT_INK
  const inkOf = (i: number) => {
    const c = safeColor(s.colors?.[i])
    if (!c) return fallback
    return c.toLowerCase() === DEFAULT_INK && opts.ink ? fallback : c
  }

  // Points in pixels, and the box they fill.
  const strokes: { pts: number[][]; ink: string }[] = []
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  s.strokes.forEach((flat, i) => {
    if (!Array.isArray(flat)) return
    const pts: number[][] = []
    for (let k = 0; k + 1 < flat.length; k += 2) {
      const x = Number(flat[k]) * SCALE
      const y = Number(flat[k + 1]) * SCALE
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      pts.push([x, y])
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
    if (pts.length) strokes.push({ pts, ink: inkOf(i) })
  })

  // Crop to the drawing, with a little paper around it.
  if (!strokes.length) {
    x0 = y0 = 0
    x1 = Math.max(1, s.w) * SCALE
    y1 = Math.max(1, s.h) * SCALE
  }
  let w = x1 - x0 + SIZE + PAD * 2
  let h = y1 - y0 + SIZE + PAD * 2
  let ox = x0 - SIZE / 2 - PAD
  let oy = y0 - SIZE / 2 - PAD
  if (w < MIN_W) {
    ox -= (MIN_W - w) / 2
    w = MIN_W
  }
  if (h < MIN_H) {
    oy -= (MIN_H - h) / 2
    h = MIN_H
  }
  w = Math.ceil(w)
  h = Math.ceil(h)

  const paths = strokes
    .map(({ pts, ink }) => {
      const local = pts.map(([x, y]) => [x! - ox, y! - oy])
      const first = local[0]!
      const isDot = local.every(([x, y]) => Math.abs(x! - first[0]!) < 0.5 && Math.abs(y! - first[1]!) < 0.5)
      if (isDot) return `<circle cx="${n(first[0]!)}" cy="${n(first[1]!)}" r="${n(SIZE * 0.45)}" fill="${ink}"/>`
      const d = pathFromOutline(
        getStroke(local, { size: SIZE, thinning: 0.5, smoothing: 0.6, streamline: 0.55, simulatePressure: true, last: true }),
      )
      return d ? `<path d="${d}" fill="${ink}"/>` : `<circle cx="${n(first[0]!)}" cy="${n(first[1]!)}" r="${n(SIZE * 0.45)}" fill="${ink}"/>`
    })
    .join('')
  const paper = safeColor(opts.paper)
  const bg = paper ? `<rect x="0" y="0" width="${w}" height="${h}" fill="${paper}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${bg}${paths}</svg>`
}
