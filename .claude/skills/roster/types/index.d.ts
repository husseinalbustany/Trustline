export type Member = {
  name: string
  /** The agent's name on the team, from the roster file; empty if it has none. */
  person: string
  /** Which portrait is drawn, e.g. "girl-2"; empty for none. */
  look: string
  description: string
  /** False for reviewers, whose tools cannot change files. */
  canEdit: boolean
}

export type LiveAgent = {
  id: string
  type: string
  description: string
  status: string
}

export type Tab = 'team' | 'live' | 'workflow' | 'rules'

declare module 'claude-code' {
  interface PluginState {
    roster: {
      tab: Tab
      team: Shaped<Member[]>
      rules: Shaped<string[]>
      live: Shaped<LiveAgent[]>
      leadBusy: boolean
    }
  }
}
