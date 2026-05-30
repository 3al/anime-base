// Shared stdin reader for module op handlers (install.mjs / status.mjs).
//
// Returns the full stdin as a string with a leading BOM stripped: PowerShell
// pipes (`echo '…' | node handler.mjs`) prepend U+FEFF, which otherwise breaks
// JSON.parse on the receiving end. Be liberal in what we accept from any shell.
// Returns '' when stdin is unreadable (e.g. no piped input).

import { readFileSync } from 'node:fs';

export function readStdin() {
  try {
    const raw = readFileSync(0, 'utf-8');
    return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  } catch {
    return '';
  }
}
