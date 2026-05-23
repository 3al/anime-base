#!/usr/bin/env node
// Node stdio-shim for vault-semantic Python MCP server.
//
// Phase 4.7 workaround: Python FastMCP stdio transport hangs on Windows
// because Claude Code's Bun runtime spawns Python with MSVCRT-line-buffered
// stdin pipes (sys.stdin.readline() blocks until buffer-full, not newline).
// This shim presents a stdio MCP server to Claude Code (Node stdio works
// fine) and forwards every JSON-RPC frame to the Python server over HTTP
// loopback. The Python server runs in FastMCP `streamable-http`, with
// `stateless_http=True` + `json_response=True` — every POST is an
// independent JSON-RPC roundtrip, no SSE session, no GET stream needed.
//
// Required env (set by harness-claude-code at registration time):
//   VAULT_SEMANTIC_PYTHON  — absolute path to the shared venv's python.exe
//   VAULT_ROOT             — absolute path to the vault (forwarded to Python)
//   HF_HOME, PYTHONIOENCODING, ... — forwarded as-is.

import { spawn } from 'node:child_process';
import { createServer, Socket } from 'node:net';
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2025-06-18';
const PORT_WAIT_TIMEOUT_MS = 30_000;
const PORT_POLL_INTERVAL_MS = 200;

const log = (msg) => process.stderr.write(`[vault-semantic-shim] ${msg}\n`);

const findFreePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const tryConnect = (port) =>
  new Promise((resolve) => {
    const s = new Socket();
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(500);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.once('timeout', () => done(false));
    s.connect(port, '127.0.0.1');
  });

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tryConnect(port)) return true;
    await new Promise((r) => setTimeout(r, PORT_POLL_INTERVAL_MS));
  }
  return false;
}

async function postFrame(port, frame) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    },
    body: frame,
  });

  // 202 Accepted = JSON-RPC notification, no body expected.
  if (res.status === 202) return [];

  const text = (await res.text()).trim();
  if (!text) return [];

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  // Stateless+json_response mode returns plain JSON, but we defensively
  // handle SSE in case stateless_http drift ever puts us on the streaming
  // branch (e.g., a tool emits progress notifications).
  if (ct.includes('text/event-stream')) {
    return text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6))
      .filter(Boolean);
  }
  return [text];
}

async function main() {
  const python = process.env.VAULT_SEMANTIC_PYTHON;
  if (!python) {
    log('FATAL: VAULT_SEMANTIC_PYTHON env required (absolute path to python.exe)');
    process.exit(2);
  }
  if (!process.env.VAULT_ROOT) {
    log('FATAL: VAULT_ROOT env required');
    process.exit(2);
  }

  const port = await findFreePort();
  log(`allocated port ${port}`);

  const childEnv = { ...process.env, MCP_HTTP_PORT: String(port) };
  const child = spawn(python, ['-m', 'vault_semantic.server'], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Forward child stdout/stderr to our stderr — must NEVER leak to our
  // stdout (which is the JSON-RPC channel to Claude Code).
  child.stdout.on('data', (d) => process.stderr.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));

  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!child.killed) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2_000).unref();
    }
    process.exit(code);
  };

  child.on('exit', (code, signal) => {
    log(`python child exited (code=${code}, signal=${signal})`);
    shutdown(code ?? 1);
  });

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  if (!(await waitForPort(port, PORT_WAIT_TIMEOUT_MS))) {
    log(`FATAL: python server did not bind ${port} within ${PORT_WAIT_TIMEOUT_MS}ms`);
    shutdown(3);
    return;
  }
  log(`python server up on 127.0.0.1:${port}`);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const frame = line.trim();
    if (!frame) return;

    // Parse only to recover the id for error replies; pass the original
    // text on the wire to preserve byte-exact JSON-RPC semantics.
    let id = null;
    try { id = JSON.parse(frame).id ?? null; } catch { /* ignore */ }

    postFrame(port, frame)
      .then((responses) => {
        for (const r of responses) process.stdout.write(`${r}\n`);
      })
      .catch((err) => {
        log(`POST failed: ${err.message}`);
        if (id !== null) {
          const reply = JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: `shim->python POST failed: ${err.message}` },
          });
          process.stdout.write(`${reply}\n`);
        }
      });
  });

  rl.on('close', () => {
    log('stdin closed, shutting down');
    shutdown(0);
  });
}

main().catch((err) => {
  log(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});
