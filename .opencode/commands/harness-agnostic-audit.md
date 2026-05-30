---
description: >
  Audit and rewrite harness-specific tool references in vault skills and governance docs so they work in both Claude Code and Opencode. Scans .claude/skills/*/SKILL.md (non-managed), SYSTEM/*.md, and CLAUDE.md for CC-only procedural patterns (`mcp__X__Y`, `AskUserQuestion`, `WebFetch`, `TaskCreate`, `subagent_type`, ...) and proposes harness-agnostic rewrites with per-file confirmation. Use when the user says /harness-agnostic-audit, "проверь скиллы на портативность", "адаптируй скиллы под Opencode", "сделай скиллы кросс-харнес", "harness audit", or wants to make a vault work in both Claude Code and Opencode.
---
Invoke the `harness-agnostic-audit` skill via the skill tool NOW.

User's arguments: $ARGUMENTS

Execute the skill's instructions IMMEDIATELY using the arguments above. Do not just acknowledge — perform the actions and report the result.
