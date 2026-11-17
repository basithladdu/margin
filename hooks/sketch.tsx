// The sketch pad: a surface module drawn inside the Margin pane. Drag to draw;
// each cell holds a 2x4 braille dot grid. Save posts the strokes to the hooks
// module, which turns them into a smooth SVG for the notebook.

import type { ClientModule, ClientPointerEvent } from 'claude-code'

type Pad = { strokes: number[][]; cur: number[] | null; saved: number }

const BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]
const BORDER = 1 // the frame's cells on each side

const SketchPad: ClientModule<{ rows?: number }, Pad> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  const pad: Pad = surface.state ?? { strokes: [], cur: null, saved: 0 }
  const cols = Math.max(8, surface.columns - BORDER * 2)
  const rows = Math.max(4, (props.rows ?? 12) - BORDER * 2)
  const W = cols * 2
  const H = rows * 4

  if (surface.state === undefined) {
    surface.onPointer((ev: ClientPointerEvent) => {
      const now = surface.state ?? pad
      const x = Math.round((ev.fine ? ev.fine.x : ev.x + 0.5) * 2) - BORDER * 2
      const y = Math.round((ev.fine ? ev.fine.y : ev.y + 0.5) * 4) - BORDER * 4
      const inside = x >= 0 && y >= 0 && x < W && y < H
      if (ev.type === 'down' && ev.button === 'left' && inside) {
        surface.setState({ ...now, cur: [x, y] })
      } else if (ev.type === 'move' && now.cur && ev.button === 'left') {
        const cx = Math.min(W - 1, Math.max(0, x))
        const cy = Math.min(H - 1, Math.max(0, y))
        const n = now.cur.length
        if (now.cur[n - 2] !== cx || now.cur[n - 1] !== cy) surface.setState({ ...now, cur: [...now.cur, cx, cy] })
      } else if ((ev.type === 'up' || ev.type === 'leave') && now.cur) {
        surface.setState({ ...now, strokes: [...now.strokes, now.cur], cur: null })
      }
    })
    surface.setState(pad)
  }

  // Rasterise every stroke into braille cells.
  const grid = new Array<number>(cols * rows).fill(0)
  const dot = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const i = Math.floor(y / 4) * cols + Math.floor(x / 2)
    grid[i] = grid[i]! | BITS[x % 2]![y % 4]!
  }
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let s = 0; s <= steps; s++) dot(Math.round(x0 + ((x1 - x0) * s) / steps), Math.round(y0 + ((y1 - y0) * s) / steps))
  }
  for (const st of pad.cur ? [...pad.strokes, pad.cur] : pad.strokes) {
    if (st.length === 2) dot(st[0]!, st[1]!)
    for (let i = 0; i + 3 < st.length; i += 2) line(st[i]!, st[i + 1]!, st[i + 2]!, st[i + 3]!)
  }
  const lines: string[] = []
  for (let r = 0; r < rows; r++) {
    let s = ''
    for (let c = 0; c < cols; c++) s += String.fromCharCode(0x2800 + grid[r * cols + c]!)
    lines.push(s)
  }

  const isEmpty = pad.strokes.length === 0 && !pad.cur
  return (
    <Box flexDirection="column" gap="xs">
      <Box borderStyle="round" borderColor="#a8a29e" flexDirection="column">
        {lines.map(l => (
          <Text mono>{l}</Text>
        ))}
      </Box>
      <Box flexDirection="row" gap="sm" alignItems="center">
        <Button
          key="pad-save"
          label="Save to notebook"
          variant="primary"
          onPress={() => {
            if (isEmpty) return
            surface.post({ type: 'save', strokes: pad.strokes, w: W, h: H })
            surface.setState({ strokes: [], cur: null, saved: pad.saved + 1 })
          }}
        />
        <Button
          key="pad-undo"
          label="Undo"
          dimColor
          onPress={() => surface.setState({ ...pad, strokes: pad.strokes.slice(0, -1), cur: null })}
        />
        <Button key="pad-clear" label="Clear" dimColor onPress={() => surface.setState({ ...pad, strokes: [], cur: null })} />
        <Text dimColor>
          {isEmpty ? (pad.saved ? 'Saved. Draw another?' : 'Drag inside the box to draw.') : `${pad.strokes.length} strokes`}
        </Text>
      </Box>
    </Box>
  )
}

export default SketchPad
