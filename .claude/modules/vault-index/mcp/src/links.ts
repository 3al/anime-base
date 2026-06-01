// Shared link-target semantics: "what counts as a link to a note".
// Used by vault_broken_links and vault_stats so broken-link counting stays
// consistent between the two tools (B: vault_stats over-counted media embeds).

// Media file extensions — embed targets like `![[Cover.jpg]]` point at
// attachments, not notes, so they must never count as broken note-links.
export const MEDIA_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.pdf', '.mp4', '.mp3', '.wav', '.ogg',
]);

export function isMediaTarget(target: string): boolean {
  const dot = target.lastIndexOf('.');
  if (dot === -1) return false;
  return MEDIA_EXTS.has(target.slice(dot).toLowerCase());
}
