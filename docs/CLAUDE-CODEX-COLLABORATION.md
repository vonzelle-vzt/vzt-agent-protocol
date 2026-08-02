# Claude And Codex Collaboration

**Last updated:** 2026-08-02

Claude Code and Codex should collaborate through explicit files, diffs, and
verification gates. Chat memory is not a protocol boundary.

## Operating Model

| Role | Default owner | Contract |
|---|---|---|
| Product and architecture lead | Claude Code | Interpret the user request, decide scope, write worker briefs, and own HITL gates. |
| Implementation worker | Codex | Make bounded code changes, run local checks, and report exact files changed. |
| Reviewer | Opposite of implementer | Review the diff for bugs, regressions, security risk, and missing tests. |
| Verifier | Either agent | Run the detected commands and record skipped checks with reasons. |

Default flow:

1. Claude decomposes the task and writes the brief.
2. Codex implements bounded work in the shared checkout or a worktree.
3. Claude reviews the diff and resolves product or architecture ambiguity.
4. Codex can run an adversarial review when Claude implemented the change.
5. The final responder reports changes, checks, skipped checks, and open risks.

## Shared Files

Use `.vzt/team/` for handoffs that must survive compaction or agent switches:

```text
.vzt/team/
├── handoff.md
├── decisions.md
├── verification.md
└── reviews/
    └── YYYY-MM-DD-agent.md
```

Any decision another agent must honor belongs in `decisions.md` or the active
handoff. Any claim that work is complete must be backed by `verification.md` or
the final command output.

## Worker Brief

Every delegated editing task needs a bounded brief:

```text
TASK: <one-line name>
CONTEXT: <constraints and decisions the worker cannot infer>
FILES_IN_SCOPE: <files or globs the worker may modify>
OPERATION: <precise change request>
ACCEPTANCE: <done state>
MACHINE_CHECK: <command chosen before dispatch>
EXPECT: <expected output or condition>
CONSTRAINTS: <hard rules, including no commit/deploy unless asked>
REPORT: <diff summary, check output, discoveries outside scope>
```

`FILES_IN_SCOPE`, `MACHINE_CHECK`, and `EXPECT` are required. If the worker needs
to write outside scope, it stops and reports the conflict.

## Surface Map

- Claude Code skills remain the installed routing commands for Claude sessions;
  Claude Code documents skills as reusable `SKILL.md` instructions invoked by
  slash command or when relevant.
- Claude Code subagents remain the model-pinned worker fleet; Claude Code
  documents subagents as isolated contexts with their own prompts, tools, and
  permissions.
- Claude Code hooks remain deterministic lifecycle enforcement; Claude Code
  documents hooks in JSON settings and notes that MCP tools appear as regular
  hook-matchable tools.
- Codex `AGENTS.md` gives repo-local durable instructions.
- Codex skills should be used for reusable workflows that also need to run in
  Codex or ChatGPT; OpenAI documents skills as focused playbooks with optional
  scripts/resources.
- Codex plugins are for installable bundles that combine skills, connectors,
  MCP servers, hooks, or scheduled task templates. Plugins are not available in
  the Codex IDE extension, so repo-local `AGENTS.md` and direct skill folders
  still matter for editor-attached work.
- Codex custom agents are the Codex-native equivalent for bounded workers and
  reviewers; OpenAI documents project agents under `.codex/agents/`.
- Codex MCP is the shared tool/context bridge for docs, GitHub, browser, Figma,
  and other external systems.
- Codex worktrees are useful for parallel background work, while `/vzt-ship`
  remains the protocol's gated long-horizon path with explicit scope and oracle
  enforcement.

## Sync Contract

This repo is the execution-layer reference for:

- routing doctrine, chair profiles, and model tier docs
- worker brief format and correction ladder
- `/vzt-ship`, scope-breach rules, and oracle verification
- VS Code mux behavior and terminal lifecycle sentinels
- hook install paths and settings schema

When any of those surfaces change here, patch
`../VZT-Tech-Consulting-Protocol` in the same update pass. When the sibling repo
changes those contracts first, mirror the corresponding docs/templates back here
before releasing.

If only one repo can be updated, write the mismatch to `.vzt/team/decisions.md`
with source repo, files touched, and required follow-up.

## Current Source Anchors

- Claude Code skills: https://docs.anthropic.com/en/docs/claude-code/skills
- Claude Code subagents: https://docs.anthropic.com/en/docs/claude-code/sub-agents
- Claude Code hooks: https://docs.anthropic.com/en/docs/claude-code/hooks
- Claude Code model configuration: https://docs.anthropic.com/en/docs/claude-code/model-config
- Codex skills and plugins: https://developers.openai.com/codex/skills-and-plugins
- Codex plugins: https://developers.openai.com/codex/plugins
- Codex subagents: https://developers.openai.com/codex/subagents
- Codex MCP: https://developers.openai.com/codex/mcp
- Codex worktrees: https://developers.openai.com/codex/environments/git-worktrees
