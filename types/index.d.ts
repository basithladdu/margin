export type MarkColor = 'yellow' | 'green' | 'pink' | 'blue' | 'orange'

export type Highlight = {
  id: string
  /** The reply block's requestId at ui.render. */
  requestId: string
  /** The selected text, as the person saw it. */
  text: string
  color: MarkColor
  note?: string
  at: number
  /** The session it was made in, and that session's folder name. */
  session?: string
  where?: string
}

export type Sketch = {
  id: string
  /** Strokes as flat [x0, y0, x1, y1, ...] lists, in braille-dot units. */
  strokes: number[][]
  /** Canvas size in dots. */
  w: number
  h: number
  at: number
  session?: string
  where?: string
}

export type MarksData = {
  /** Highlights keyed by reply block requestId. */
  highlights: Record<string, Highlight[]>
  /** Reply blocks that carry a "read up to here" marker (one per session). */
  markers: string[]
  sketches: Sketch[]
}

export type PaneView = 'notebook' | 'resume' | 'sketch'

declare module 'claude-code' {
  interface PluginState {
    margin: {
      data: Shaped<MarksData>
      /** The highlight whose note field is open in the band, or null. */
      noting: string | null
      /** A short line the band shows after an action. */
      flash: string | null
      view: PaneView
      /** Notebook shows every session's marks, not just this one's. */
      showAll: boolean
      /** The row above the prompt is folded down to one button. */
      hidden: boolean
      /** Notebook search text and colour filter ('all' or a MarkColor). */
      query: string
      filter: string
    }
  }
}
