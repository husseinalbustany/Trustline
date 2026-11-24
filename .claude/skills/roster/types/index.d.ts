export type Member = {
  name: string
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
