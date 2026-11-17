/** A highlight's look: five colours, or a pen-style underline or strike. */
export type MarkColor = 'yellow' | 'green' | 'pink' | 'blue' | 'orange' | 'underline' | 'strike'

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
  /** The opening words of the reply it sits in, for context in the notebook. */
  context?: string
}

export type Sketch = {
  id: string
  /** Strokes as flat [x0, y0, x1, y1, ...] lists, in braille-dot units. */
  strokes: number[][]
  /** One ink colour per stroke (a CSS hex colour); absent means the default ink. */
  colors?: string[]
  /** Canvas size in dots. */
  w: number
  h: number
  at: number
  session?: string
  where?: string
  /** The reply it was drawn under, when drawn in the chat. */
  requestId?: string
  /** The opening words of that reply. */
  context?: string
}

export type MarksData = {
  /** Highlights keyed by reply block requestId. */
  highlights: Record<string, Highlight[]>
  /** Reply blocks that carry a "read up to here" marker (one per session). */
  markers: string[]
  sketches: Sketch[]
}

/** What one reply draws from: its highlights, marker and sketches. */
export type ReplyMarks = {
  highlights: Highlight[]
  isMarked: boolean
  sketches: Sketch[]
  /** The sketch pad is open under this reply. */
  isSketching: boolean
}

export type PaneView = 'notebook' | 'resume' | 'reply'

declare module 'claude-code' {
  interface PluginState {
    margin: {
      data: Shaped<MarksData>
      /** One member per reply block, so a change redraws only that reply. */
      reply: StateFamily<ReplyMarks>
      /** The highlight whose note field is open in the band, or null. */
      noting: string | null
      /** A short line the band shows after an action. */
      flash: string | null
      view: PaneView
      /** The reply the pane shows in its 'reply' view. */
      focus: string | null
      /** Notebook shows every session's marks, not just this one's. */
      showAll: boolean
      /** The row above the prompt is folded down to one button. */
      hidden: boolean
      /** Notebook search text and colour filter ('all' or a MarkColor). */
      query: string
      filter: string
      /** An Undo is available for the last change. */
      canUndo: boolean
    }
  }
}
