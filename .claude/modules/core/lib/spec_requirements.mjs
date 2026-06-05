// spec-requirements contract — shared logic for the changelog-enforcement hooks
// (harness-claude-code PostToolUse + harness-opencode plugin) and any tooling
// that needs to read a create-skill's machine-readable requirements manifest.
//
// Each /new-<kind>/SKILL.md carries a managed block:
//
//   <!-- BEGIN: spec-requirements (managed contract — sync with SYSTEM/spec_changelog.yaml) -->
//   ```yaml
//   kind: <slug>
//   requirements:
//     - requirement: <field name | "## Section heading" | stable format label>
//       kind_of: field | section | format
//   ```
//   <!-- END: spec-requirements -->
//
// The block declares WHAT the skill requires now; SYSTEM/spec_changelog.yaml
// holds WHEN each requirement was introduced (ledger-protocol §4.1). The two
// must stay in sync — vault_spec_drift (vault-index) is the deterministic
// backstop; the hooks here are the live reminder.
//
// Parsing strategy mirrors mcp_registry.mjs / opencode_wrappers.mjs: targeted
// regex over a small, known shape — NOT a general YAML parser. Anchors and
// multi-line scalars are out of scope.

const BEGIN_MARK = 'BEGIN: spec-requirements';
const END_MARK = 'END: spec-requirements';

/**
 * Locate the spec-requirements block char range in `text`.
 * @returns {{start:number, end:number}|null} — [start,end) span covering the
 *   BEGIN marker line through the END marker line, or null if absent.
 */
export function findRequirementsBlockRange(text) {
  const beginIdx = text.indexOf(BEGIN_MARK);
  if (beginIdx === -1) return null;
  const endMarkIdx = text.indexOf(END_MARK, beginIdx);
  if (endMarkIdx === -1) return null;
  // Expand to the start of the BEGIN line and the end of the END line so an
  // edit landing anywhere on either marker line counts as "inside the block".
  const start = text.lastIndexOf('\n', beginIdx) + 1; // 0 if marker on first line
  const afterEnd = text.indexOf('\n', endMarkIdx);
  const end = afterEnd === -1 ? text.length : afterEnd + 1;
  return { start, end };
}

/**
 * Extract and parse the spec-requirements manifest from a SKILL.md body.
 * @param {string} skillMdText
 * @returns {{kind:(string|null), requirements:Array<{requirement:string, kind_of:string}>}|null}
 *   null when no block is present.
 */
export function extractRequirementsBlock(skillMdText) {
  const range = findRequirementsBlockRange(skillMdText);
  if (!range) return null;
  const block = skillMdText.slice(range.start, range.end);

  // Strip the fenced ```yaml ... ``` wrapper if present; tolerate its absence.
  const fenceMatch = block.match(/```ya?ml\s*\r?\n([\s\S]*?)\r?\n```/i);
  const body = fenceMatch ? fenceMatch[1] : block;

  const kindMatch = body.match(/^\s*kind:\s*(.+?)\s*$/m);
  const kind = kindMatch ? stripQuotes(kindMatch[1].trim()) : null;

  const requirements = [];
  const lines = body.split(/\r?\n/);
  let pending = null;
  for (const line of lines) {
    const reqMatch = line.match(/^\s*-\s*requirement:\s*(.+?)\s*$/);
    if (reqMatch) {
      if (pending) requirements.push(pending);
      pending = { requirement: stripQuotes(reqMatch[1].trim()), kind_of: 'field' };
      continue;
    }
    if (pending) {
      const kindOfMatch = line.match(/^\s*kind_of:\s*(.+?)\s*$/);
      if (kindOfMatch) pending.kind_of = stripQuotes(kindOfMatch[1].trim());
    }
  }
  if (pending) requirements.push(pending);

  return { kind, requirements };
}

/**
 * Decide whether a tool edit plausibly touched the spec-requirements block —
 * the anti-noise gate for the reminder hooks. Generous toward reminding (a
 * spurious reminder is cheap; a missed requirement change is the bug we fix),
 * but silent on pure prose edits that never approach the block.
 *
 * @param {string} fileText   — current on-disk SKILL.md content (post-edit).
 * @param {string} [oldString] — Edit.old_string (empty/undefined for Write).
 * @param {string} [newString] — Edit.new_string (empty/undefined for Write).
 * @returns {boolean}
 */
export function editTouchedBlock(fileText, oldString, newString) {
  const old = oldString || '';
  const neu = newString || '';

  // Whole-file write (no diff strings) — can't localize, assume touched.
  if (!old && !neu) return true;

  // Either side mentions the block markers or manifest keys → touched. Catches
  // adding the block from scratch, or editing requirement lines directly.
  const mentionsManifest = (s) =>
    s.includes('spec-requirements') ||
    /^\s*-?\s*requirement:/m.test(s) ||
    /^\s*kind_of:/m.test(s);
  if (mentionsManifest(old) || mentionsManifest(neu)) return true;

  // Positional: does the inserted text land inside/overlapping the block range?
  const range = findRequirementsBlockRange(fileText);
  if (!range) return false; // no block, no marker mention → prose edit elsewhere
  if (!neu) return false;
  const idx = fileText.indexOf(neu);
  if (idx === -1) return false;
  const insEnd = idx + neu.length;
  return idx < range.end && insEnd > range.start; // interval overlap
}

/**
 * Reminder text injected into the agent's context when a create-skill spec edit
 * touched the requirements block. Harness-neutral wording.
 * @param {string|null} kind — slug from the block, when known.
 * @returns {string}
 */
export function buildReminderText(kind) {
  const which = kind ? `/new-${kind}` : 'a /new-* create-skill';
  return (
    `[spec-changelog] You edited the spec-requirements block of ${which}. ` +
    `If you introduced a NEW requirement (field / section / format rule), append it ` +
    `to SYSTEM/spec_changelog.yaml with today's date AND to the skill's spec-requirements ` +
    `block — in this same change. Skipping the changelog makes audits (audit-by-creator / ` +
    `audit-note) falsely penalize cards created before the requirement (ledger-protocol §4.1). ` +
    `Verify with the vault_spec_drift MCP tool. If you only refactored prose, ignore this.`
  );
}

function stripQuotes(s) {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}
