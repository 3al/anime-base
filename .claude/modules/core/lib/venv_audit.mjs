// Persistent audit log for venv/directory operations on shared install roots.
//
// Purpose (D22, 2026-05-20): debug the case "empty .venv mysteriously appears
// after atomicSwap rename". Whoever calls python -m venv, renameSync, rmSync,
// or mkdirSync against a .venv path emits a record here with caller context
// (argv, PID/parent PID, JS stack trace). Logs are append-only newline-JSON.
//
// File location: <shared_module_dir>/.venv-audit.log (gitignored — per-machine
// state, not part of the bundle).
//
// Visibility: also echoed to stderr with a [venv-audit] prefix so the event
// surfaces in install.mjs / shared_install.mjs stderr capture.
//
// Failure mode: audit write errors are swallowed — instrumentation must never
// break the actual install. Stderr always prints (no swallow).

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Append one event record to the audit log + echo to stderr.
 *
 * @param {string} auditFile - abs path to <shared_module_dir>/.venv-audit.log
 * @param {string} event - e.g. 'venv_create_start', 'atomic_swap_rename',
 *   'venv_create_done', 'atomic_swap_cleanup', 'atomic_swap_rollback'
 * @param {object} details - event-specific fields (paths, exit codes, etc)
 */
export function logVenvOp(auditFile, event, details = {}) {
  const stack = (new Error().stack || '')
    .split('\n')
    .slice(2, 10)
    .map((s) => s.trim())
    .filter(Boolean);

  const record = {
    ts: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    event,
    cwd: process.cwd(),
    argv: process.argv,
    env_summary: {
      VAULT_ROOT: process.env.VAULT_ROOT || null,
      MCP_HTTP_PORT: process.env.MCP_HTTP_PORT || null,
      VAULT_SEMANTIC_PYTHON: process.env.VAULT_SEMANTIC_PYTHON || null,
    },
    details,
    stack,
  };

  try {
    mkdirSync(dirname(auditFile), { recursive: true });
    appendFileSync(auditFile, JSON.stringify(record) + '\n');
  } catch { /* never break install on audit failure */ }

  // Echo to stderr — install.mjs captures stderr for diagnostics, and humans
  // reading transcripts can see it inline.
  const summary = `${event} pid=${process.pid} ppid=${process.ppid} ${JSON.stringify(details)}`;
  try { process.stderr.write(`[venv-audit] ${summary}\n`); } catch { /* ignore */ }
}

/**
 * Resolve the audit file path for a given shared module dir. Used so callers
 * don't hardcode the filename.
 */
export function venvAuditPath(sharedModuleDir) {
  return `${sharedModuleDir.replace(/\\/g, '/').replace(/\/+$/, '')}/.venv-audit.log`;
}
