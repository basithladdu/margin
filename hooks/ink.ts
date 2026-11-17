// Turns sketch strokes into a smooth SVG with perfect-freehand (MIT, Steve Ruiz).

import { getStroke } from './vendor/perfect-freehand/getStroke'
import type { Sketch } from '../types'

const SCALE = 6 // pixels per braille dot

function pathFromOutline(points: number[][]): string {
  if (points.length < 2) return ''
  const avg = (a: number, b: number) => ((a + b) / 2).toFixed(2)
  const p = (i: number) => points[i]!
  let d = `M${p(0)[0]!.toFixed(2)},${p(0)[1]!.toFixed(2)} Q`
  for (let i = 0; i < points.length; i++) {
    const a = p(i)
    const b = p((i + 1) % points.length)
    d += `${a[0]!.toFixed(2)},${a[1]!.toFixed(2)} ${avg(a[0]!, b[0]!)},${avg(a[1]!, b[1]!)} `
  }
  return d + 'Z'
}

export function sketchSvg(s: Sketch, opts: { ink?: string; paper?: string } = {}): string {
  const ink = opts.ink ?? '#1c1917'
  const w = Math.max(1, s.w) * SCALE
  const h = Math.max(1, s.h) * SCALE
  const paths = s.strokes
    .map(flat => {
      const pts: number[][] = []
      for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i]! * SCALE, flat[i + 1]! * SCALE])
      if (pts.length === 1) pts.push([pts[0]![0]! + 0.5, pts[0]![1]! + 0.5])
      const outline = getStroke(pts, { size: 9, thinning: 0.5, smoothing: 0.6, streamline: 0.55, simulatePressure: true })
      return `<path d="${pathFromOutline(outline)}" fill="${ink}"/>`
    })
    .join('')
  const bg = opts.paper ? `<rect width="100%" height="100%" fill="${opts.paper}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${bg}${paths}</svg>`
}
