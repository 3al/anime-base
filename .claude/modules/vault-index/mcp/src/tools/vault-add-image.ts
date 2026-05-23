import { z } from 'zod';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';

const IMAGE_TYPES = ['top', 'bottom', 'side', 'cross-section', 'stem', 'habitat', 'spore-print'] as const;
type ImageType = typeof IMAGE_TYPES[number];

const TYPE_LABELS: Record<ImageType, string> = {
  'top': 'Шляпка сверху',
  'bottom': 'Гименофор',
  'side': 'Общий вид',
  'cross-section': 'Срез мякоти',
  'stem': 'Ножка',
  'habitat': 'В естественной среде',
  'spore-print': 'Споровый отпечаток',
};

export function registerAddImageTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_add_image',
    'Add a typed image to a mushroom card: updates frontmatter images dict and gallery section. Returns updated image status.',
    {
      note: z.string().describe('Note name or path.'),
      imageType: z.enum(IMAGE_TYPES).describe('View type: top, bottom, side, cross-section, stem, habitat.'),
      imagePath: z.string().describe('Path to image file relative to vault root (e.g. ".attachments/Boletus_Edulis_side.jpg").'),
    },
    async ({ note, imageType, imagePath }) => {
      await index.ensureFresh();

      // 1. Resolve note
      const record = index.resolve(note);
      if (!record) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Note "${note}" not found.` }) }] };
      }

      // 2. Check image file exists
      const absoluteImagePath = join(index.vaultRoot, imagePath);
      try {
        await stat(absoluteImagePath);
      } catch {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Image file not found: ${imagePath}` }) }] };
      }

      // 3. Read the note file
      const absoluteNotePath = join(index.vaultRoot, record.path);
      let content = await readFile(absoluteNotePath, 'utf-8');

      // 4. Update frontmatter images dict
      content = updateFrontmatterImages(content, imageType, imagePath);

      // 5. Update gallery section
      const imageFileName = imagePath.split('/').pop() ?? imagePath;
      content = updateGallery(content, imageType, imageFileName);

      // 6. Update `updated:` date
      const today = new Date().toISOString().slice(0, 10);
      content = updateFrontmatterField(content, 'updated', today);

      // 7. Write back
      await writeFile(absoluteNotePath, content, 'utf-8');

      // 8. Collect current image status
      const updatedContent = await readFile(absoluteNotePath, 'utf-8');
      const currentImages = extractImagesFromFrontmatter(updatedContent);

      const result = {
        success: true,
        note: record.name,
        path: record.path,
        added: { type: imageType, path: imagePath },
        currentImages,
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}

function updateFrontmatterImages(content: string, imageType: string, imagePath: string): string {
  const lines = content.split('\n');

  // Find frontmatter boundaries
  if (lines[0]?.trim() !== '---') return content;
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') { endIndex = i; break; }
  }
  if (endIndex === -1) return content;

  // Find `images:` line in frontmatter
  let imagesLineIdx = -1;
  for (let i = 1; i < endIndex; i++) {
    if (lines[i]!.match(/^images\s*:/)) {
      imagesLineIdx = i;
      break;
    }
  }

  if (imagesLineIdx === -1) {
    // No images: section — add before closing ---
    const newLines = [
      'images:',
      `  ${imageType}: "${imagePath}"`,
    ];
    lines.splice(endIndex, 0, ...newLines);
  } else {
    // Find extent of images block (indented lines after `images:`)
    let blockEnd = imagesLineIdx + 1;
    while (blockEnd < endIndex && lines[blockEnd]!.match(/^\s{2,}\S/)) {
      blockEnd++;
    }

    // Check if this type already exists
    let replaced = false;
    for (let i = imagesLineIdx + 1; i < blockEnd; i++) {
      const match = lines[i]!.match(/^(\s+)(\S+)\s*:/);
      if (match && match[2] === imageType) {
        lines[i] = `${match[1]}${imageType}: "${imagePath}"`;
        replaced = true;
        break;
      }
    }

    if (!replaced) {
      // Add new entry at end of images block
      lines.splice(blockEnd, 0, `  ${imageType}: "${imagePath}"`);
    }
  }

  return lines.join('\n');
}

function updateGallery(content: string, imageType: string, imageFileName: string): string {
  const label = TYPE_LABELS[imageType as ImageType] ?? imageType;
  const embed = `![[${imageFileName}]]`;
  const galleryEntry = `### ${label}\n${embed}`;

  // Find ## Галерея section
  const galleryMatch = content.match(/^## Галерея$/m);
  if (!galleryMatch || galleryMatch.index === undefined) {
    // No gallery section — don't add one (let the skill handle structure)
    return content;
  }

  // Check if this subsection already exists
  const subheadingRe = new RegExp(`^### ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
  if (subheadingRe.test(content)) {
    // Replace existing embed under this subheading
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.match(subheadingRe)) {
        // Next line should be the embed — replace it
        if (i + 1 < lines.length && lines[i + 1]!.startsWith('![[')) {
          lines[i + 1] = embed;
        } else {
          lines.splice(i + 1, 0, embed);
        }
        return lines.join('\n');
      }
    }
  }

  // Find next ## heading after Галерея to insert before it
  const afterGallery = content.slice(galleryMatch.index + galleryMatch[0].length);
  const nextH2 = afterGallery.match(/\n## /);

  if (nextH2 && nextH2.index !== undefined) {
    const insertPos = galleryMatch.index + galleryMatch[0].length + nextH2.index;
    return content.slice(0, insertPos) + '\n\n' + galleryEntry + '\n' + content.slice(insertPos);
  } else {
    // Gallery is last section — append
    return content + '\n\n' + galleryEntry + '\n';
  }
}

function updateFrontmatterField(content: string, field: string, value: string): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return content;

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') { endIndex = i; break; }
  }
  if (endIndex === -1) return content;

  for (let i = 1; i < endIndex; i++) {
    if (lines[i]!.match(new RegExp(`^${field}\\s*:`))) {
      lines[i] = `${field}: ${value}`;
      return lines.join('\n');
    }
  }

  // Field not found — add before closing ---
  lines.splice(endIndex, 0, `${field}: ${value}`);
  return lines.join('\n');
}

function extractImagesFromFrontmatter(content: string): Record<string, string> {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return {};

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') { endIndex = i; break; }
  }
  if (endIndex === -1) return {};

  let imagesLineIdx = -1;
  for (let i = 1; i < endIndex; i++) {
    if (lines[i]!.match(/^images\s*:/)) { imagesLineIdx = i; break; }
  }
  if (imagesLineIdx === -1) return {};

  const images: Record<string, string> = {};
  for (let i = imagesLineIdx + 1; i < endIndex; i++) {
    const match = lines[i]!.match(/^\s+(\S+)\s*:\s*"?([^"]+)"?\s*$/);
    if (match) {
      images[match[1]!] = match[2]!;
    } else if (!lines[i]!.match(/^\s/)) {
      break; // No longer indented — end of images block
    }
  }

  return images;
}
