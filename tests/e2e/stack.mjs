// Starts the system under test for Playwright: the plotly-client backend and
// three dummy boards, all on dedicated ports so a real instance on 8080/8099
// is never disturbed. Build first with `cargo build --workspace`.
//
//   127.0.0.1  normal board, 50 Hz
//   127.0.0.2  second board (proves per-device routing)
//   127.0.0.3  board that "reboots" every 6 s (timestamp clock restarts)
//   127.0.0.4  motionless, level board with constant readings (--still 0)
//   127.0.0.5  motionless board rolled 30° with constant readings (--still 30)

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const HTTP_PORT = 18080;
export const UDP_PORT = 18099;
export const REBOOT_EVERY_S = 6;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exe = (name) => path.join(root, 'target', 'debug', process.platform === 'win32' ? `${name}.exe` : name);

const children = [];

function start(name, args) {
  const bin = exe(name);
  if (!existsSync(bin)) {
    console.error(`${bin} not found. Run \`cargo build --workspace\` first.`);
    process.exit(1);
  }
  const child = spawn(bin, args, {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'warn' },
  });
  child.on('exit', (code) => {
    console.error(`${name} ${args.join(' ')} exited with ${code}`);
    shutdown(1);
  });
  children.push(child);
}

function shutdown(code = 0) {
  for (const c of children) c.removeAllListeners('exit'), c.kill();
  process.exit(code);
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

start('plotly-client', ['--no-open', '--http-port', String(HTTP_PORT), '--udp-port', String(UDP_PORT)]);
const board = ['-p', String(UDP_PORT), '-a', '127.0.0.1'];
start('udp-dummy-server', [...board, '--bind', '127.0.0.1']);
start('udp-dummy-server', [...board, '--bind', '127.0.0.2']);
start('udp-dummy-server', [...board, '--bind', '127.0.0.3', '--reboot-after', String(REBOOT_EVERY_S)]);
start('udp-dummy-server', [...board, '--bind', '127.0.0.4', '--still', '0']);
start('udp-dummy-server', [...board, '--bind', '127.0.0.5', '--still', '30']);
