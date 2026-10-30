/**
 * The stdio entry of WorldView's MCP server (mcp-server.ts). An MCP client starts it with
 * WorldView's own executable run as Node:
 *
 *   ELECTRON_RUN_AS_NODE=1  "<WorldView.exe>"  "<resources>/app.asar.unpacked/dist/mcp/worldview-mcp.cjs"
 *
 * It reads one JSON-RPC message per line on stdin, answers on stdout, logs nothing there, and
 * reaches the running app only through the local API's socket (Linux) or named pipe (Windows).
 */
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { handleMcpMessage, type LocalApiGet } from './mcp-server.js';

declare const __WORLDVIEW_BUILD__: { version?: string } | undefined;

const MAX_LINE = 1024 * 1024;
const MAX_ANSWER = 5 * 1024 * 1024;

function endpoint(env: NodeJS.ProcessEnv): string | undefined {
  if (env['WORLDVIEW_API']) return env['WORLDVIEW_API'];
  if (process.platform === 'win32') {
    const user = (env['USERNAME'] ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '_')
      .slice(0, 64);
    return user ? `\\\\.\\pipe\\worldview-api-${user}` : undefined;
  }
  const dir = env['XDG_RUNTIME_DIR'];
  return dir && path.isAbsolute(dir) ? path.join(dir, 'worldview', 'api.sock') : undefined;
}

export function localApiGet(socketPath: string | undefined, timeoutMs = 8000): LocalApiGet {
  return (apiPath) =>
    new Promise((resolve, reject) => {
      if (!socketPath) {
        reject(new Error('not running: no session to find WorldView in'));
        return;
      }
      const req = http.request({ socketPath, path: apiPath, method: 'GET', timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_ANSWER) req.destroy(new Error('answer too large'));
          else chunks.push(c);
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
            });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end();
    });
}

function main(): void {
  const version = (typeof __WORLDVIEW_BUILD__ !== 'undefined' && __WORLDVIEW_BUILD__?.version) || '0.0.0';
  const get = localApiGet(endpoint(process.env));
  const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = Promise.resolve();
  lines.on('line', (line) => {
    if (!line.trim()) return;
    // Answered in order, one at a time: the local API allows a few requests a second.
    pending = pending.then(async () => {
      if (line.length > MAX_LINE) {
        write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'message too large' } });
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        return;
      }
      const reply = await handleMcpMessage(msg, get, { version });
      if (reply) write(reply);
    });
  });
  lines.on('close', () => void pending.then(() => process.exit(0)));
}

main();
