# Roster

A panel for this project's Claude agents. Type `/roster` to open it.

- **Team**: the agents in `.claude/agents`, split into those that can change
  files and those that only review. A filled dot marks one that is working.
- **Live**: the agents that have run in this session and their status.
- **Workflow**: the order work moves through the team.
- **Rules**: the "Rules that are easy to break" section of `CLAUDE.md`.

Each agent's name on the team and its portrait come from
`.claude/roster.json`: `name` is shown beside the role, and `look` picks one
of eight drawn portraits (`girl-1` to `girl-4`, `boy-1` to `boy-4`). An agent
not listed there is shown by its role alone.

Press Refresh after adding or editing an agent file. Add an agent by adding a
file to `.claude/agents`; the panel reads the folder, so nothing else changes.

It loads on its own in a Claude Code session opened on this repository. To
check it after a change:

```bash
claude plugin validate .claude/skills/roster
claude plugin test .claude/skills/roster
```
