# Branch backups (temporary)

Two branches were built in separate working copies and are not merged yet.
They exist only in this container, so they are kept here as git bundles to
survive a restart. Remove this folder once both are merged.

- `risk-management-api.bundle`: risk management steps 8 to 10 (step 10 in
  progress), on top of 3cb3342. Head: d6dd341.
- `ai-insights-assistant.bundle`: AI drafting review-18 fixes, AI insights,
  review-21 fixes (M1 and L4 left), and the chat assistant (in progress), on
  top of 057ec9f. Head: b41ac01.

Restore with, for example:

    git fetch .branch-backups/risk-management-api.bundle risk-management-api:risk-management-api
    git fetch .branch-backups/ai-insights-assistant.bundle worktree-agent-a401760666624b587:ai-insights-assistant

Also kept here, so they survive a restart:
- `held-migrations/`: Ziad's draft migration for security review 20 (main's
  code already needs it). Regenerate and renumber after the risk branch's
  migrations when merging.
- `contracts/`: the API contracts the web engineer works from.
- `reviews/`: every security, language and quality review with its decisions.
