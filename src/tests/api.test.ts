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

const password = 'EinLangesTestpasswort!';

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  server.close();
  return port;
}

async function startApi(options: { secrets?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'screenable-api-'));
  const runtime = join(dir, 'run');
  atomicWrite(join(dir, 'config.json'), JSON.stringify(defaultConfig));
  if (options.secrets !== false) saveSecrets(join(dir, 'secrets.json'), createSecrets(password));
  const port = await freePort();
  const child = spawn(process.execPath, ['dist/api.js'], {
    cwd: process.cwd(), stdio: 'ignore',
    env: { ...process.env, SCREENABLE_STATE_DIR: dir, SCREENABLE_RUN_DIR: runtime, SCREENABLE_PORT: String(port), SCREENABLE_HOST: '127.0.0.1' },
  });
  const origin = `http://127.0.0.1:${port}`;
  const base = `${origin}/api/v1`;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* Start läuft. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const login = async (value = password) => fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: value }) });
  const stop = async () => {
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    rmSync(dir, { recursive: true, force: true });
    return code as number | null;
  };
  return { dir, runtime, origin, base, login, stop };
}

test('Login, CSRF, Revision und Player-Kommando', async () => {
  const api = await startApi();
  try {
    const { base, dir, runtime } = api;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/config`)).status, 401);
    const login = await api.login();
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
    assert.equal((await fetch(`${base}/config`, { method: 'PUT', headers: valid, body: JSON.stringify({ contentUrl: 'x'.repeat(20_000) }) })).status, 413);
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).revision, 1);
    const restart = await fetch(`${base}/player/restart`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
    assert.equal(restart.status, 202);
    assert.equal(JSON.parse(readFileSync(join(runtime, 'command.json'), 'utf8')).action, 'restart');
    const status = await (await fetch(`${base}/status`, { headers })).json() as { version: string; player: { state: string } };
    assert.match(status.version, /^\d+\.\d+\.\d+/);
    assert.equal(status.player.state, 'unknown');
    const logout = await fetch(`${base}/logout`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(`${base}/config`, { headers })).status, 401);
  } finally { assert.equal(await api.stop(), 0); }
});

test('Passwortwechsel meldet bestehende Sitzungen ab', async () => {
  const api = await startApi();
  try {
    const login = await api.login();
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(`${api.base}/config`, { headers: { cookie } })).status, 200);
    saveSecrets(join(api.dir, 'secrets.json'), createSecrets('EinNeuesTestpasswort!'));
    assert.equal((await fetch(`${api.base}/config`, { headers: { cookie } })).status, 401);
    assert.equal((await api.login()).status, 401);
    assert.equal((await api.login('EinNeuesTestpasswort!')).status, 200);
  } finally { await api.stop(); }
});

test('Login-Limit hält auch parallelen Versuchen stand', async () => {
  const api = await startApi();
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => api.login('falsches-passwort')));
    const statuses = results.map(r => r.status);
    assert.equal(statuses.filter(s => s === 429).length, 3, statuses.join(','));
    assert.ok(statuses.every(s => [401, 429, 503].includes(s)), statuses.join(','));
    const blocked = await api.login();
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  } finally { await api.stop(); }
});

test('Ohne Passwort bleibt die API erreichbar, Anmeldung ist gesperrt', async () => {
  const api = await startApi({ secrets: false });
  try {
    assert.equal((await fetch(`${api.base}/health`)).status, 200);
    assert.equal((await api.login()).status, 503);
  } finally { await api.stop(); }
});

test('Statische Dateien, Sicherheitsheader und Pfadschutz', async () => {
  const api = await startApi();
  try {
    const index = await fetch(`${api.origin}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type')!, /^text\/html/);
    assert.match(index.headers.get('content-security-policy')!, /default-src 'self'/);
    assert.equal(index.headers.get('x-frame-options'), 'DENY');
    assert.equal(index.headers.get('cross-origin-opener-policy'), 'same-origin');
    const html = await index.text();
    assert.match(html, /<div id="app">/);
    assert.equal((await fetch(`${api.origin}/einstellungen`)).status, 200);
    const script = html.match(/src="(\/assets\/[^"]+\.js)"/)![1];
    const js = await fetch(`${api.origin}${script}`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('cache-control')!, /immutable/);
    const head = await fetch(`${api.origin}${script}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), js.headers.get('content-length'));
    const diagnostic = await fetch(`${api.origin}/diagnostic.html`);
    assert.equal(diagnostic.status, 200);
    assert.match(diagnostic.headers.get('content-security-policy')!, /media-src 'self' blob:/);
    for (const path of ['/fehlt.js', '/assets/fehlt.css', '/%2e%2e/package.json', '/assets/..%2f..%2fpackage.json']) {
      assert.equal((await fetch(`${api.origin}${path}`)).status, 404, path);
    }
  } finally { await api.stop(); }
});
