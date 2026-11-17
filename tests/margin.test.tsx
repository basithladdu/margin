import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const REPLY =
  '## Plan\n\nFirst we **read the file** and then we `fix` the bug.\n\n- one item\n- two items\n\n```js\nconst x = 1\n```\n\nLast paragraph stays plain.'

const msg = (surface: 'terminal' | 'desktop', requestId = 'm1', text = REPLY) =>
  ({
    plugin: 'margin',
    surface,
    component: 'AssistantMessage',
    requestId,
    props: { text, isFirstOfReply: true },
  }) as const

const BAND = {
  plugin: 'margin',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'margin',
  component: 'Pane',
  requestId: 'margin',
  props: {
    title: 'Margin',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

let selection: { text: string; requestId?: string } | undefined

function engine(on: On) {
  on('command.register', () => ({ value: { command: 'margin' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('env.get', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // The desktop app refuses to scroll its transcript for a mod.
  on('ui.scroll', { plugin: '*' } as {}, () => ({ deny: 'not scrollable here' }))
  on('ui.selection', () => ({ value: selection }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine draws this</Text>
  })
  mock.store(on)
  mock.clock(on)
}

test('a highlight is drawn in colour, the rest stays markdown, on both surfaces', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const reply = await $.ui.mount(msg(surface))
    await reply.unmount()
  }
  selection = { text: 'read the file and then', requestId: 'm1' }
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'hl-yellow' })
  await band.input({ key: 'note', text: 'key step' })
  await band.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(msg(surface))
    expect(await ui.find({ type: 'Text', text: 'read the file and then' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /key step/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Last paragraph/ })).toBeDefined()
    await ui.unmount()
  }
})

test('erase takes a highlight off; a plain reply goes back to the engine', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const first = await $.ui.mount(msg('desktop'))
  await first.unmount()

  selection = { text: 'one item\ntwo items', requestId: 'm1' }
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'hl-green' })
  selection = { text: 'two', requestId: 'm1' }
  await band.press({ key: 'erase' })
  expect(await band.find({ type: 'Text', text: /Removed 1 highlight/ })).toBeDefined()
  await band.unmount()

  const after = await $.ui.mount(msg('desktop'))
  expect(await after.find({ type: 'Text', text: 'engine draws this' })).toBeDefined()
  await after.unmount()
})

test('mark, resume falls back to the pane, clear mark removes it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const [id, text] of [['m1', REPLY], ['m2', 'The second reply, not read yet.']] as const) {
    const r = await $.ui.mount(msg('desktop', id, text))
    await r.unmount()
  }
  selection = { text: 'Last paragraph', requestId: 'm1' }
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'mark' })
  await band.press({ key: 'resume' })

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Markdown', text: /second reply/ })).toBeDefined()
  await pane.unmount()

  const marked = await $.ui.mount(msg('desktop'))
  expect(await marked.find({ type: 'Text', text: /stopped reading here/ })).toBeDefined()
  await marked.press({ key: 'margin-unmark' })
  await marked.unmount()

  expect(await band.find({ key: 'resume' })).toBeUndefined()
  await band.unmount()
})

test('the sketch pad saves a drawing to the notebook', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'sketch' })
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.resize({ columns: 40, rows: 18, in: 'pad' })
  await pane.pointer({ type: 'down', x: 3, y: 2, button: 'left', in: 'pad' })
  await pane.pointer({ type: 'move', x: 9, y: 4, button: 'left', in: 'pad' })
  await pane.pointer({ type: 'up', x: 9, y: 4, button: 'left', in: 'pad' })
  expect(await pane.find({ type: 'Text', text: /1 strokes/, in: 'pad' })).toBeDefined()
  await pane.press({ key: 'pad-save' })
  await pane.press({ key: 'tab-notebook' })
  expect(await pane.find({ type: 'Svg' })).toBeDefined()
  await pane.unmount()
})

test('the row folds away and comes back, by button and by /margin', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'hide' })
  expect(await band.find({ key: 'hl-yellow' })).toBeUndefined()
  await band.press({ key: 'show' })
  expect(await band.find({ key: 'hl-yellow' })).toBeDefined()
  await $.command.run({ command: 'margin', args: 'hide' } as never)
  expect(await band.find({ key: 'show' })).toBeDefined()
  await $.command.run({ command: 'margin', args: 'show' } as never)
  expect(await band.find({ key: 'quote' })).toBeDefined()
  await band.unmount()
})

test('quote puts the selection in the prompt; search filters the notebook', async ($, on) => {
  engine(on)
  let filled = ''
  on('prompt.fill', (_, e) => {
    filled = e.text
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.ui.mount(msg('desktop'))
  await r.unmount()

  selection = { text: 'one item', requestId: 'm1' }
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'quote' })
  expect(filled).toBe('> one item\n\n')
  await band.press({ key: 'hl-blue' })
  selection = { text: 'Last paragraph', requestId: 'm1' }
  await band.press({ key: 'hl-orange' })
  await band.press({ key: 'notebook' })
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.findAll({ type: 'Button', text: /^Remove$/ })).toHaveLength(2)
  await pane.input({ key: 'search', text: 'last', kind: 'change' })
  expect(await pane.findAll({ type: 'Button', text: /^Remove$/ })).toHaveLength(1)
  await pane.input({ key: 'search', text: '', kind: 'change' })
  await pane.press({ key: 'f-blue' })
  expect(await pane.findAll({ type: 'Button', text: /^Remove$/ })).toHaveLength(1)
  await pane.unmount()
})

test('compact rows and a hidden start follow the settings', { options: { rowStyle: 'compact', startHidden: true } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'show' })).toBeDefined()
  await band.press({ key: 'show' })
  expect(await band.find({ type: 'Button', text: /Mark read here/ })).toBeUndefined()
  expect(await band.find({ key: 'mark' })).toBeDefined()
  await band.unmount()
})
