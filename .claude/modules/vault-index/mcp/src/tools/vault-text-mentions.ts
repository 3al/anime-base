import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';

interface Mention {
  source: string;
  sourcePath: string;
  line: number;
  lineText: string;
  matchedTerm: string;
}

// Any frontmatter key matching this regex with a string value is treated as a
// candidate search term (e.g. name_romaji, name_english, title_original).
// Heuristic instead of a fixed list so tool stays generic across themes.
const NAME_FIELD_PATTERN = /^(name|title)_/;

const MIN_TERM_LENGTH = 2;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function registerTextMentionsTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_text_mentions',
    "Find plain-text mentions of a target note's name/aliases in other notes' bodies, excluding lines that already WikiLink to the target. Use for reverse-check workflows after creating/renaming a card: discover where the new card is mentioned by name in sibling cards so they can be upgraded to WikiLinks (and optionally gallery thumbnails). Search terms are auto-derived from frontmatter (note name with underscores→spaces, aliases[], any string-valued extra field matching ^(name|title)_). Case-sensitive, Unicode word-boundary aware, skips frontmatter / fenced code / inline code / headings.",
    {
      note: z.string().describe('Target note name or path. Frontmatter aliases and name/title_* fields become search terms.'),
      noteKinds: z
        .array(z.string())
        .optional()
        .describe('Restrict source notes to these note_kind values (e.g. ["mushroom-card", "character"]). Omit to scan all kinds.'),
      includeTarget: z
        .boolean()
        .optional()
        .describe('Include mentions inside the target note itself (default false — self-mentions are usually noise).'),
    },
    async ({ note, noteKinds, includeTarget }) => {
      await index.ensureFresh();

      const target = index.resolve(note);
      if (!target) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: `Note not found: ${note}` }, null, 2) },
          ],
        };
      }

      const terms = new Set<string>();
      const nameAsWords = target.name.replace(/_/g, ' ').trim();
      if (nameAsWords) terms.add(nameAsWords);
      for (const alias of target.aliases) {
        const trimmed = alias.trim();
        if (trimmed) terms.add(trimmed);
      }
      for (const [key, value] of Object.entries(target.extra)) {
        if (!NAME_FIELD_PATTERN.test(key)) continue;
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (trimmed) terms.add(trimmed);
      }

      const sortedTerms = Array.from(terms)
        .filter((t) => t.length >= MIN_TERM_LENGTH)
        .sort((a, b) => b.length - a.length);

      if (sortedTerms.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { note: target.name, terms: [], mentions: [], count: 0 },
                null,
                2,
              ),
            },
          ],
        };
      }

      const termRegexes = sortedTerms.map((t) => ({
        term: t,
        re: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(t)}(?![\\p{L}\\p{N}_])`, 'u'),
      }));

      const kindsSet = noteKinds && noteKinds.length > 0 ? new Set(noteKinds) : null;
      const mentions: Mention[] = [];

      for (const src of index.allNotes()) {
        if (!includeTarget && src.path === target.path) continue;
        if (kindsSet && (src.note_kind === null || !kindsSet.has(src.note_kind))) continue;

        const linkedLines = new Set<number>();
        for (const link of src.outgoingLinks) {
          if (link.target === target.name) linkedLines.add(link.line);
        }

        let content: string;
        try {
          content = await readFile(join(index.vaultRoot, src.path), 'utf-8');
        } catch {
          continue;
        }

        const lines = content.split('\n');

        let bodyStart = 0;
        if (lines[0]?.trim() === '---') {
          for (let i = 1; i < lines.length; i++) {
            if (lines[i]?.trim() === '---') {
              bodyStart = i + 1;
              break;
            }
          }
        }

        let inCode = false;
        for (let i = bodyStart; i < lines.length; i++) {
          const line = lines[i]!;
          const lineNumber = i + 1;

          if (line.trimStart().startsWith('```')) {
            inCode = !inCode;
            continue;
          }
          if (inCode) continue;
          if (/^\s{0,3}#{1,6}\s/.test(line)) continue;
          if (linkedLines.has(lineNumber)) continue;

          const cleaned = line.replace(/`[^`]+`/g, '');

          for (const { term, re } of termRegexes) {
            if (re.test(cleaned)) {
              mentions.push({
                source: src.name,
                sourcePath: src.path,
                line: lineNumber,
                lineText: line,
                matchedTerm: term,
              });
              break;
            }
          }
        }
      }

      const text = JSON.stringify(
        {
          note: target.name,
          terms: sortedTerms,
          mentions,
          count: mentions.length,
        },
        null,
        2,
      );

      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
