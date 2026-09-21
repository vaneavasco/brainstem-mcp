// Test-only "client" process (not shipped, not imported by any src/ file): spawns the real stdio
// server (src/stdio-main.ts, given as argv[2]) as its own child over piped stdio, completes the
// MCP handshake, then keeps several `vault_list` calls in flight continuously — one more queued
// for every line of response it reads back, so the pipe is never idle. Prints `CHILD_PID <pid>`
// to its OWN stdout once the server has answered at least once, so a test can capture the
// server's pid before killing this relay process (never the server) to reproduce "a client that
// dies with calls in flight leaves the server orphaned" (see tests/stdio/client-death.test.ts).
import { spawn } from 'node:child_process';

const [entry, vaultRoot] = process.argv.slice(2);
if (!entry || !vaultRoot) {
  process.stderr.write('usage: busy-relay.ts <stdio-main entry> <vault root>\n');
  process.exit(1);
}

const child = spawn(process.execPath, [entry, '--vault', vaultRoot], {
  stdio: ['pipe', 'pipe', 'ignore'],
});

child.stdin.write(
  `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'busy-relay', version: '0' },
    },
  })}\n`,
);
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

let nextId = 2;
const pump = (): void => {
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/call',
      params: { name: 'vault_list', arguments: { depth: 3 } },
    })}\n`,
  );
};

child.stdout.once('data', () => {
  process.stdout.write(`CHILD_PID ${child.pid}\n`);
  for (let i = 0; i < 8; i += 1) pump();
  child.stdout.on('data', (d: Buffer) => {
    for (const _line of d.toString().split('\n').slice(1)) pump();
  });
});
