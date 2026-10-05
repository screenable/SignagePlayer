import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createSecrets, saveSecrets } from '../auth.js';
import { atomicWrite, defaultConfig } from '../config.js';

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  server.close();
  return port;
}

test('Login, CSRF, Revision und Player-Kommando', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'screenable-api-'));
  const runtime = join(dir, 'run');
  const password = 'EinLangesTestpasswort!';
  atomicWrite(join(dir, 'config.json'), JSON.stringify(defaultConfig));
  saveSecrets(join(dir, 'secrets.json'), createSecrets(password));
  const port = await freePort();
  const child = spawn(process.execPath, ['dist/api.js'], {
    cwd: process.cwd(), stdio: 'ignore',
    env: { ...process.env, SCREENABLE_STATE_DIR: dir, SCREENABLE_RUN_DIR: runtime, SCREENABLE_PORT: String(port), SCREENABLE_HOST: '127.0.0.1' },
  });
  const base = `http://127.0.0.1:${port}/api/v1`;
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* Start läuft. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/config`)).status, 401);
    const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    assert.equal(login.status, 200);
    const { csrf } = await login.json() as { csrf: string };
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const headers = { cookie, 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/config`, { headers })).status, 200);
    const payload = JSON.stringify({ contentUrl: 'https://example.com/game', outputId: null });
    assert.equal((await fetch(`${base}/config`, { method: 'PUT', headers: { ...headers, 'if-match': '0' }, body: payload })).status, 403);
    const valid = { ...headers, 'x-csrf-token': csrf, 'if-match': '0' };
    assert.equal((await fetch(`${base}/config`, { method: 'PUT', headers: valid, body: JSON.stringify({ contentUrl: 'http://example.com/', outputId: null }) })).status, 400);
    assert.equal((await fetch(`${base}/config`, { method: 'PUT', headers: valid, body: payload })).status, 200);
    assert.equal((await fetch(`${base}/config`, { method: 'PUT', headers: valid, body: payload })).status, 409);
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).revision, 1);
    const restart = await fetch(`${base}/player/restart`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
    assert.equal(restart.status, 202);
    assert.equal(JSON.parse(readFileSync(join(runtime, 'command.json'), 'utf8')).action, 'restart');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
    rmSync(dir, { recursive: true, force: true });
  }
});
