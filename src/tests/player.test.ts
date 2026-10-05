import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, defaultConfig } from '../config.js';

async function waitFor<T>(read: () => T | null, timeout = 10_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = read(); if (value) return value; } catch { /* Noch nicht bereit. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Zeitüberschreitung beim Warten auf den Player.');
}

test('Single-Player startet Chromium und erholt sich nach Prozessabsturz', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'screenable-player-'));
  const bin = join(dir, 'bin');
  const runtime = join(dir, 'run');
  mkdirSync(bin); mkdirSync(runtime);
  const script = (name: string, code: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${code}\n`); chmodSync(path, 0o755);
  };
  script('xrandr', 'if [ "$1" = "--query" ]; then echo "HDMI-1 connected primary 1920x1080+0+0"; fi');
  script('xdotool', 'exit 1');
  script('chromium', 'exec sleep 100');
  atomicWrite(join(dir, 'config.json'), JSON.stringify({ ...defaultConfig, contentUrl: 'https://example.com/', recovery: { browserRestartDelaySeconds: 1, maxRapidRestarts: 5 } }));
  const child = spawn(process.execPath, ['dist/player.js'], {
    cwd: process.cwd(), stdio: 'ignore',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DISPLAY: ':99', SCREENABLE_STATE_DIR: dir, SCREENABLE_RUN_DIR: runtime },
  });
  try {
    const first = await waitFor(() => {
      const s = JSON.parse(readFileSync(join(runtime, 'status.json'), 'utf8')) as { browserPid: number | null; state: string };
      return s.state === 'running' && s.browserPid ? s.browserPid : null;
    });
    process.kill(first, 'SIGKILL');
    const second = await waitFor(() => {
      const s = JSON.parse(readFileSync(join(runtime, 'status.json'), 'utf8')) as { browserPid: number | null; state: string };
      return s.state === 'running' && s.browserPid && s.browserPid !== first ? s.browserPid : null;
    });
    assert.notEqual(second, first);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
    rmSync(dir, { recursive: true, force: true });
  }
});
