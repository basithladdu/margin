// The sketch pad: a surface module drawn under a reply in the transcript. Drag to
// draw; each cell holds a 2x4 braille dot grid, coloured by the last stroke
// through it. Save posts the strokes to the hooks module, which keeps them under
// the reply and turns them into a smooth SVG (hooks/ink.ts).

import type { ClientModule, ClientPointerEvent } from 'claude-code'

type Snapshot = { strokes: number[][]; colors: string[] }
type Pad = Snapshot & {
  /** The stroke being drawn, flat [x0, y0, x1, y1, ...] in dots. */
  cur: number[] | null
  /** The palette index of the ink in hand. */
  ink: number
  isErasing: boolean
  /** The eraser's last point while it is dragged, and whether that drag took a stroke yet. */
  eraseAt: number[] | null
  hasErased: boolean
  /** What Undo goes back to, oldest first. */
  past: Snapshot[]
  saved: number
  /** Save was pressed on an empty pad. */
  isNudged: boolean
}

const INKS = [
  { hex: '#1c1917', name: 'Black' },
  { hex: '#dc2626', name: 'Red' },
  { hex: '#2563eb', name: 'Blue' },
  { hex: '#16a34a', name: 'Green' },
  { hex: '#ea580c', name: 'Orange' },
]
const BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]
const BORDER = 1 // the frame's cells on each side
const FALLBACK_COLS = 40 // canvas width before the first layout
const MIN_STEP = 0.75 // dots between kept samples
const ERASE_RADIUS = 2 // dots
const HISTORY = 40
const POST_BUDGET = 12000 // numbers in one save, well inside a post's bounds
const HINT = 'Drag to draw · pick an ink · Save keeps it under this reply'

const INIT: Pad = {
  strokes: [],
  colors: [],
  cur: null,
  ink: 0,
  isErasing: false,
  eraseAt: null,
  hasErased: false,
  past: [],
  saved: 0,
  isNudged: false,
}

const q = (v: number) => Math.round(v * 10) / 10
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const remember = (p: Pad): Snapshot[] => [...p.past, { strokes: p.strokes, colors: p.colors }].slice(-HISTORY)

/** The pointer in dots, relative to the canvas inside the frame. */
function toDots(ev: ClientPointerEvent): [number, number] {
  const cx = ev.fine ? ev.fine.x : ev.x + 0.5
  const cy = ev.fine ? ev.fine.y : ev.y + 0.5
  return [(cx - BORDER) * 2, (cy - BORDER) * 4]
}

function commit(p: Pad): Pad {
  if (!p.cur) return p
  return {
    ...p,
    past: remember(p),
    strokes: [...p.strokes, p.cur],
    colors: [...p.colors, (INKS[p.ink] ?? INKS[0]!).hex],
    cur: null,
  }
}

// Distances for the eraser.
function toSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  const t = len ? clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}
function crosses(a: number[], b: number[], c: number[], d: number[]): boolean {
  const side = (p: number[], q1: number[], q2: number[]) => Math.sign((q2[0]! - q1[0]!) * (p[1]! - q1[1]!) - (q2[1]! - q1[1]!) * (p[0]! - q1[0]!))
  return side(a, c, d) * side(b, c, d) < 0 && side(c, a, b) * side(d, a, b) < 0
}
function nearSegments(a: number[], b: number[], c: number[], d: number[]): number {
  if (crosses(a, b, c, d)) return 0
  return Math.min(
    toSegment(a[0]!, a[1]!, c[0]!, c[1]!, d[0]!, d[1]!),
    toSegment(b[0]!, b[1]!, c[0]!, c[1]!, d[0]!, d[1]!),
    toSegment(c[0]!, c[1]!, a[0]!, a[1]!, b[0]!, b[1]!),
    toSegment(d[0]!, d[1]!, a[0]!, a[1]!, b[0]!, b[1]!),
  )
}
function isTouched(st: number[], a: number[], b: number[]): boolean {
  if (st.length === 2) return toSegment(st[0]!, st[1]!, a[0]!, a[1]!, b[0]!, b[1]!) <= ERASE_RADIUS
  for (let i = 0; i + 3 < st.length; i += 2) {
    if (nearSegments([st[i]!, st[i + 1]!], [st[i + 2]!, st[i + 3]!], a, b) <= ERASE_RADIUS) return true
  }
  return false
}

/** Drags the eraser from its last point to (x, y), taking the strokes it passes. */
function erase(p: Pad, x: number, y: number): Pad {
  const a = p.eraseAt ?? [x, y]
  const b = [x, y]
  const keep = p.strokes.map(st => !isTouched(st, a, b))
  if (keep.every(Boolean)) return { ...p, eraseAt: b }
  return {
    ...p,
    past: p.hasErased ? p.past : remember(p),
    strokes: p.strokes.filter((_, i) => keep[i]),
    colors: p.colors.filter((_, i) => keep[i]),
    eraseAt: b,
    hasErased: true,
  }
}

/** Ramer-Douglas-Peucker on a flat list, keeping the ends. */
function simplify(st: number[], eps: number): number[] {
  const m = st.length / 2
  if (m <= 2) return st
  const keep = new Array<boolean>(m).fill(false)
  keep[0] = keep[m - 1] = true
  const stack: [number, number][] = [[0, m - 1]]
  while (stack.length) {
    const [i, j] = stack.pop()!
    let far = -1
    let best = eps
    for (let k = i + 1; k < j; k++) {
      const d = toSegment(st[2 * k]!, st[2 * k + 1]!, st[2 * i]!, st[2 * i + 1]!, st[2 * j]!, st[2 * j + 1]!)
      if (d > best) {
        best = d
        far = k
      }
    }
    if (far > 0) {
      keep[far] = true
      stack.push([i, far], [far, j])
    }
  }
  const out: number[] = []
  for (let k = 0; k < m; k++) if (keep[k]) out.push(st[2 * k]!, st[2 * k + 1]!)
  return out
}
/** Thins long drawings until one post can carry them. */
function fit(strokes: number[][]): number[][] {
  let out = strokes
  for (let eps = 0.2; eps < 20; eps *= 2) {
    if (out.reduce((n, st) => n + st.length, 0) <= POST_BUDGET) break
    out = strokes.map(st => simplify(st, eps))
  }
  return out
}

const SketchPad: ClientModule<{ rows?: number }, Pad> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  const pad: Pad = surface.state ?? INIT
  const cols = surface.columns > 0 ? Math.max(8, surface.columns - BORDER * 2) : FALLBACK_COLS
  const rows = clamp(Math.round(typeof props?.rows === 'number' ? props.rows : 10), 3, 40)
  const W = cols * 2
  const H = rows * 4

  // Set again on each call, so it always sees this call's size.
  surface.onPointer((ev: ClientPointerEvent) => {
    const now = surface.state ?? INIT
    const [x, y] = toDots(ev)
    const inside = x >= 0 && y >= 0 && x < W && y < H
    if (ev.type === 'down') {
      if (ev.button !== 'left') return
      const base = commit(now) // a stroke whose 'up' never came
      if (!inside) {
        if (base !== now) surface.setState(base)
      } else if (base.isErasing) {
        surface.setState(erase({ ...base, eraseAt: null, hasErased: false, isNudged: false }, x, y))
      } else {
        surface.setState({ ...base, cur: [q(clamp(x, 0, W - 0.1)), q(clamp(y, 0, H - 0.1))], isNudged: false })
      }
    } else if (ev.type === 'move') {
      if (ev.button !== 'left') {
        if (now.cur) surface.setState(commit(now))
        else if (now.eraseAt) surface.setState({ ...now, eraseAt: null })
      } else if (now.eraseAt) {
        surface.setState(erase(now, x, y))
      } else if (now.cur) {
        const cx = q(clamp(x, 0, W - 0.1))
        const cy = q(clamp(y, 0, H - 0.1))
        const n = now.cur.length
        if (Math.hypot(cx - now.cur[n - 2]!, cy - now.cur[n - 1]!) >= MIN_STEP) surface.setState({ ...now, cur: [...now.cur, cx, cy] })
      }
    } else if (ev.type === 'up') {
      if (now.cur) surface.setState(commit(now))
      else if (now.eraseAt) surface.setState({ ...now, eraseAt: null })
    }
  })

  // Rasterise every stroke into braille cells; a cell takes the colour of the
  // last stroke through it. Between samples the line follows a Catmull-Rom curve.
  const grid = new Array<number>(cols * rows).fill(0)
  const tint = new Array<number>(cols * rows).fill(0)
  let ink = 0
  const dot = (fx: number, fy: number) => {
    const x = Math.floor(fx)
    const y = Math.floor(fy)
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const i = (y >> 2) * cols + (x >> 1)
    grid[i] = grid[i]! | BITS[x & 1]![y & 3]!
    tint[i] = ink
  }
  const curve = (st: number[]) => {
    const m = st.length >> 1
    if (m === 0) return
    if (m === 1) return dot(st[0]!, st[1]!)
    const P = (k: number) => {
      const j = clamp(k, 0, m - 1)
      return [st[2 * j]!, st[2 * j + 1]!] as const
    }
    for (let i = 0; i < m - 1; i++) {
      const [x0, y0] = P(i - 1)
      const [x1, y1] = P(i)
      const [x2, y2] = P(i + 1)
      const [x3, y3] = P(i + 2)
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2))
      for (let s = 0; s <= steps; s++) {
        const t = s / steps
        const t2 = t * t
        const t3 = t2 * t
        dot(
          0.5 * (2 * x1 + (x2 - x0) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (3 * x1 - x0 - 3 * x2 + x3) * t3),
          0.5 * (2 * y1 + (y2 - y0) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (3 * y1 - y0 - 3 * y2 + y3) * t3),
        )
      }
    }
  }
  pad.strokes.forEach((st, i) => {
    ink = Math.max(0, INKS.findIndex(k => k.hex === pad.colors[i]))
    curve(st)
  })
  if (pad.cur) {
    ink = pad.ink
    curve(pad.cur)
  }

  // One mono Text per row, with a coloured run per stretch of one ink. Blank
  // cells join whichever run they sit in. Ink 0 draws in the theme's own text
  // colour so it shows on a dark terminal too.
  const colorOf = (k: number) => (k > 0 ? INKS[k]!.hex : undefined)
  const lines = []
  for (let r = 0; r < rows; r++) {
    const runs: { k: number; s: string }[] = []
    let k = -1
    let s = ''
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const ch = String.fromCharCode(0x2800 + grid[i]!)
      if (grid[i] && k !== tint[i]) {
        if (k === -1) k = tint[i]!
        else {
          runs.push({ k, s })
          k = tint[i]!
          s = ''
        }
      }
      s += ch
    }
    runs.push({ k: Math.max(0, k), s })
    lines.push(
      runs.length === 1 && runs[0]!.k === 0 ? (
        <Text mono>{runs[0]!.s}</Text>
      ) : (
        <Text mono>
          {runs.map(run => (
            <Text color={colorOf(run.k)}>{run.s}</Text>
          ))}
        </Text>
      ),
    )
  }

  const count = pad.strokes.length
  const isEmpty = count === 0 && !pad.cur
  const status = pad.isNudged
    ? 'Draw something first, then Save.'
    : pad.isErasing
      ? 'Eraser: drag across a stroke to remove it · pick an ink to draw again'
      : isEmpty
        ? pad.saved
          ? 'Saved under this reply. Draw another, or Close.'
          : HINT
        : `${count} ${count === 1 ? 'stroke' : 'strokes'} · Save keeps it under this reply`

  return (
    <Box flexDirection="column" gap="xs">
      <Box borderStyle="round" borderColor="#a8a29e" flexDirection="column">
        {lines}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" gap="sm">
        <Box flexDirection="row" alignItems="center" gap="sm">
          {INKS.map((k, i) => {
            const isOn = !pad.isErasing && pad.ink === i
            return (
              <Button
                key={`ink-${i}`}
                label={`${k.name} ink${isOn ? ' (in hand)' : ''}`}
                plain
                onPress={() => surface.setState({ ...pad, ink: i, isErasing: false, eraseAt: null })}
              >
                <Text color={colorOf(i)} weight={isOn ? 'bold' : undefined}>
                  {isOn ? '◉' : '●'}
                </Text>
              </Button>
            )
          })}
          <Button
            key="pad-eraser"
            label={pad.isErasing ? '◉ Eraser' : 'Eraser'}
            dimColor={!pad.isErasing}
            onPress={() => surface.setState({ ...commit(pad), isErasing: !pad.isErasing, eraseAt: null })}
          />
        </Box>
        <Box flexDirection="row" alignItems="center" gap="sm">
          <Button
            key="pad-undo"
            label="Undo"
            dimColor
            onPress={() => {
              const prev = pad.past[pad.past.length - 1]
              if (prev) surface.setState({ ...pad, ...prev, past: pad.past.slice(0, -1), cur: null, eraseAt: null })
            }}
          />
          <Button
            key="pad-clear"
            label="Clear"
            dimColor
            onPress={() => {
              if (isEmpty) return
              const p = commit(pad)
              surface.setState({ ...p, past: remember(p), strokes: [], colors: [], cur: null, eraseAt: null })
            }}
          />
          <Button key="pad-cancel" label="Close" dimColor onPress={() => surface.post({ type: 'cancel' })} />
          <Button
            key="pad-save"
            label="Save"
            variant="primary"
            onPress={() => {
              const p = commit(pad)
              if (!p.strokes.length) {
                if (!pad.isNudged) surface.setState({ ...pad, isNudged: true })
                return
              }
              surface.post({ type: 'save', strokes: fit(p.strokes), colors: p.colors, w: W, h: H })
              surface.setState({ ...INIT, ink: pad.ink, saved: pad.saved + 1 })
            }}
          />
        </Box>
      </Box>
      <Text dimColor>{status}</Text>
    </Box>
  )
}

export default SketchPad
