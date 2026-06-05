#!/usr/bin/env node
// harness-claude-code — PostToolUse hook: spec-changelog reminder.
//
// Fires after Edit/Write/MultiEdit. When the edited file is a create-skill spec
// (.claude/skills/new-<kind>/SKILL.md) AND the edit plausibly touched the
// spec-requirements block, injects a reminder to sync SYSTEM/spec_changelog.yaml
// in the same change. Anti-noise: pure prose edits outside the block stay silent
// (editTouchedBlock). Reminder, not block — never fails the tool call.
//
// Installed at .claude/modules/harness-claude-code/hooks/ by the install handler,
// which registers `node <this>` as a PostToolUse command in .claude/settings.json.
// Shared detection logic: core/lib/spec_requirements.mjs (same lib the Opencode
// plugin uses — single contract, two harness bindings).

import { readFileSync, existsSync } from 'node:fs';
import { readStdin } from '../../core/lib/read_input.mjs';
import {
  editTouchedBlock,
  extractRequirementsBlock,
  findRequirementsBlockRange,
  buildReminderText,
} from '../../core/lib/spec_requirements.mjs';

const SKILL_PATH_RE = /\.claude\/skills\/new-[^/]+\/SKILL\.md$/;

function emitReminder(kind) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: buildReminderText(kind),
      },
    }),
  );
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin() || '{}');
  } catch {
    process.exit(0); // malformed payload — never interfere with the tool
  }

  const toolName = payload.tool_name;
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') process.exit(0);

  const ti = payload.tool_input || {};
  const filePath = ti.file_path || ti.filePath;
  if (!filePath) process.exit(0);
  if (!SKILL_PATH_RE.test(String(filePath).replace(/\\/g, '/'))) process.exit(0);
  if (!existsSync(filePath)) process.exit(0);

  let text;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch {
    process.exit(0);
  }

  let touched;
  if (toolName === 'Write') {
    // Whole-file write: can't diff. Remind only if the written file carries the
    // block (a blockless write is a missing-manifest case the backstop catches).
    touched = findRequirementsBlockRange(text) !== null;
  } else if (toolName === 'MultiEdit') {
    const edits = Array.isArray(ti.edits) ? ti.edits : [];
    touched = edits.some((e) => editTouchedBlock(text, e.old_string, e.new_string));
  } else {
    touched = editTouchedBlock(text, ti.old_string, ti.new_string);
  }
  if (!touched) process.exit(0);

  const block = extractRequirementsBlock(text);
  emitReminder(block ? block.kind : null);
  process.exit(0);
}

main();
