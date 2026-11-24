import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'roster',
  component: 'Pane',
  requestId: 'roster',
  props: {
    title: 'Roster',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// Nothing sits beneath the plugin in a test: these stand for the engine.
type On = Parameters<Parameters<typeof test>[1]>[1]
function engine(on: On) {
  on('command.register', () => ({ value: { command: 'roster' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

const AGENT = (name: string, tools: string) =>
  `---\nname: ${name}\ndescription: Does ${name} work. More detail here.\ntools: ${tools}\n---\n\nBody.`

const NOTES = `# Project\n\n## Rules that are easy to break\n\n- **Tenant isolation.** Every table has it. More.\n- **No text in components.** All wording lives\n  in the dictionaries.\n\n## Other\n\n- not a rule\n`

test('the roster lists agents from the project, grouped by what they may do', async ($, on) => {
  engine(on)
  on('fs.list', () => ({ value: [
    { name: 'api-engineer.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
    { name: 'code-reviewer.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
    { name: 'notes.txt', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
  ] }))
  on('fs.read', (_, e) => ({
    value:
      e.path === 'CLAUDE.md'
        ? NOTES
        : AGENT(
            e.path.includes('api') ? 'api-engineer' : 'code-reviewer',
            e.path.includes('api') ? 'Read, Edit, Write, Bash' : 'Read, Grep, Bash',
          ),
  }))
  on('agent.list', () => ({ value: [] }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /Agents/ }))?.text).toMatch(/Agents 2/)
    expect((await ui.find({ type: 'Text', text: /api-engineer/ }))?.text).toMatch(
      /○ api-engineer Does api-engineer work\./,
    )
    expect(await ui.find({ type: 'Text', text: /Build/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Review / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /notes/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the Rules tab shows the rules section of CLAUDE.md and nothing after it', async ($, on) => {
  engine(on)
  on('fs.list', () => ({ value: [] }))
  on('fs.read', () => ({ value: NOTES }))
  on('agent.list', () => ({ value: [] }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-rules' })

  expect((await ui.find({ type: 'Text', text: /Tenant isolation/ }))?.text).toBe(
    '• Tenant isolation.',
  )
  expect(await ui.find({ type: 'Text', text: /No text in components/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /not a rule/ })).toBeUndefined()
  await ui.unmount()
})

test('the Live tab marks an agent that is running', async ($, on) => {
  engine(on)
  on('fs.list', () => ({ value: [] }))
  on('fs.read', () => ({ value: '' }))
  on('agent.list', () => ({
    value: [
      { id: 'a1', type: 'security-reviewer', description: 'Review branch', status: 'running', kind: 'local_agent' },
    ],
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /Working now/ }))?.text).toMatch(/Working now 1/)
  await ui.press({ key: 'tab-live' })
  expect((await ui.find({ type: 'Text', text: /security-reviewer/ }))?.text).toMatch(
    /● security-reviewer running Review branch/,
  )
  await ui.unmount()
})
