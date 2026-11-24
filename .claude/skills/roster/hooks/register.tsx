import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LiveAgent, Member, Tab } from '../types'

const PANE = 'roster'
const AGENTS_DIR = '.claude/agents'
const RULES_FILE = 'CLAUDE.md'
const RULES_HEADING = '## Rules that are easy to break'

const tab = atom({ plugin: 'roster', key: 'tab' } as const, 'team' as Tab)
const team = atom({ plugin: 'roster', key: 'team' } as const, [], {
  shape: 'team-1',
})
const rules = atom({ plugin: 'roster', key: 'rules' } as const, [], {
  shape: 'rules-1',
})
const live = atom({ plugin: 'roster', key: 'live' } as const, [], {
  shape: 'live-1',
})

const TABS: { id: Tab; label: string; hotkey: string }[] = [
  { id: 'team', label: 'Team', hotkey: '1' },
  { id: 'live', label: 'Live', hotkey: '2' },
  { id: 'workflow', label: 'Workflow', hotkey: '3' },
  { id: 'rules', label: 'Rules', hotkey: '4' },
]

// How work moves through the team. Kept in step with CLAUDE.md.
const WORKFLOW = [
  ['Owner', 'Asks for the work and decides what ships.'],
  ['Lead', 'The main Claude session. Splits the work and hands it out.'],
  ['database-engineer', 'Tables, migrations and access rules, when data changes.'],
  ['api-engineer', 'Endpoints, rules and API tests.'],
  ['web-engineer', 'Screens, in English and Arabic.'],
  ['test-engineer', 'Runs the tests and the feature in a real browser.'],
  ['security-reviewer', 'Reviews anything touching sign-in, permissions or data.'],
  ['bilingual-reviewer', 'Reviews any screen or wording change.'],
  ['code-reviewer', 'Reviews the finished change before it is merged.'],
]

/** Reads one `key: value` line from an agent file's front matter. */
function field(text: string, key: string): string {
  const head = text.split('\n---')[0] ?? ''
  const line = head.split('\n').find(l => l.startsWith(`${key}:`))

  return line ? line.slice(key.length + 1).trim() : ''
}

function firstSentence(text: string): string {
  const end = text.indexOf('. ')

  return end === -1 ? text : text.slice(0, end + 1)
}

/** One bullet's text: its bold lead-in and the first sentence after it. */
function ruleOf(bullet: string): string {
  const plain = bullet.replace(/\s+/g, ' ').replaceAll('**', '').replaceAll('`', '')

  return firstSentence(plain)
}

async function loadTeam($: EngineInterface): Promise<Member[]> {
  const entries = await $.fs.list(AGENTS_DIR).catch(() => [])
  const files = entries
    .filter(e => e.kind === 'file' && e.name.endsWith('.md'))
    .map(e => e.name)
    .sort()
  const members: Member[] = []

  for (const file of files) {
    const text = await $.fs.read(`${AGENTS_DIR}/${file}`).catch(() => '')
    const tools = field(text, 'tools')
    members.push({
      name: field(text, 'name') || file.replace(/\.md$/, ''),
      description: firstSentence(field(text, 'description')),
      // No `tools` line means every tool, so the agent can edit.
      canEdit: tools === '' || /\b(Edit|Write)\b/.test(tools),
    })
  }

  return members
}

async function loadRules($: EngineInterface): Promise<string[]> {
  const text = await $.fs.read(RULES_FILE).catch(() => '')
  const start = text.indexOf(RULES_HEADING)

  if (start === -1) {
    return []
  }

  const section = text.slice(start + RULES_HEADING.length).split('\n## ')[0] ?? ''

  return section
    .split('\n- ')
    .slice(1)
    .map(ruleOf)
    .filter(rule => rule !== '')
}

async function loadLive($: EngineInterface): Promise<LiveAgent[]> {
  const agents = await $.agent.list().catch(() => [])

  return agents.map(a => ({
    id: a.id,
    type: a.type,
    description: a.description,
    status: a.status,
  }))
}

async function refresh($: EngineInterface): Promise<void> {
  const [members, ruleList, agents] = await Promise.all([
    loadTeam($),
    loadRules($),
    loadLive($),
  ])
  await update($, team, () => members)
  await update($, rules, () => ruleList)
  await update($, live, () => agents)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'roster',
      description: "Show the project's Claude agents, who is working, the workflow and the rules",
    })
    await refresh($)

    return next(e)
  })

  on('command.run', { command: 'roster' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Roster' })
    const members = await read($, team)

    return { text: `Roster opened: ${members.length} agents.` }
  })

  // Keep the Live tab current as agents are started.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    const agents = await loadLive($)
    await update($, live, () => agents)

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, tab)
    const members = await read($, team)
    const ruleList = await read($, rules)
    const agents = await read($, live)
    const working = agents.filter(a => a.status === 'running')
    const builders = members.filter(m => m.canEdit)
    const reviewers = members.filter(m => !m.canEdit)

    const isWorking = (name: string) => working.some(a => a.type === name)

    // A count in its own box.
    const tile = (label: string, value: number) => (
      <Box borderStyle="round" paddingX={1}>
        <Text>
          <Text dimColor>{label} </Text>
          <Text bold>{String(value)}</Text>
        </Text>
      </Box>
    )

    // A named box in the chain of command.
    const chip = (name: string) => (
      <Box borderStyle="round" paddingX={1}>
        <Text bold>{name}</Text>
      </Box>
    )

    // One agent: its name with a dot that fills while it works, and what it does.
    const card = (m: Member) => (
      <Box
        borderStyle="round"
        borderDimColor={!isWorking(m.name)}
        paddingX={1}
        flexDirection="column"
      >
        <Text bold>
          {isWorking(m.name) ? '● ' : '○ '}
          {m.name}
        </Text>
        <Text dimColor>{m.description}</Text>
      </Box>
    )

    const group = (title: string, note: string, list: Member[]) => (
      <Box flexDirection="column">
        <Text>
          <Text bold>{title}</Text>
          <Text dimColor> · {note}</Text>
        </Text>
        {list.map(card)}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1} flexWrap="wrap">
          {TABS.map(t => (
            <Button
              key={`tab-${t.id}`}
              label={t.label}
              hotkey={t.hotkey}
              variant={t.id === current ? 'primary' : 'secondary'}
              onPress={() => update($, tab, () => t.id)}
            />
          ))}
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($)} />
        </Box>

        <Box gap={1} flexWrap="wrap">
          {tile('Working now', working.length)}
          {tile('Agents', members.length)}
          {tile('Engineers', builders.length)}
          {tile('Reviewers', reviewers.length)}
        </Box>

        {current === 'team' && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Box gap={1} alignItems="center">
                {chip('Owner')}
                <Text dimColor>→</Text>
                {chip('Lead')}
              </Box>
              <Text dimColor>
                You decide what ships. The main Claude session hands out the work.
              </Text>
            </Box>
            {members.length === 0 && (
              <Text dimColor>No agents found in {AGENTS_DIR}.</Text>
            )}
            {builders.length > 0 && group('Build', 'can change files', builders)}
            {reviewers.length > 0 && group('Review', 'read and report only', reviewers)}
          </Box>
        )}

        {current === 'live' && (
          <Box flexDirection="column">
            {agents.length === 0 && (
              <Text dimColor>No agents have run in this session yet.</Text>
            )}
            {agents.map(a => (
              <Box
                borderStyle="round"
                borderDimColor={a.status !== 'running'}
                paddingX={1}
                flexDirection="column"
              >
                <Text bold={a.status === 'running'}>
                  {a.status === 'running' ? '● ' : '○ '}
                  {a.type}
                  <Text dimColor> {a.status}</Text>
                </Text>
                <Text dimColor>{a.description}</Text>
              </Box>
            ))}
          </Box>
        )}

        {current === 'workflow' && (
          <Box flexDirection="column">
            {WORKFLOW.map(([who, what], i) => (
              <Box gap={1}>
                <Text dimColor>{String(i + 1)}</Text>
                <Box flexDirection="column">
                  <Text bold>{who}</Text>
                  <Text dimColor>{what}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}

        {current === 'rules' && (
          <Box flexDirection="column">
            {ruleList.length === 0 && (
              <Text dimColor>No rules section found in {RULES_FILE}.</Text>
            )}
            {ruleList.map(rule => (
              <Box borderStyle="round" borderDimColor paddingX={1}>
                <Text>{rule}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
