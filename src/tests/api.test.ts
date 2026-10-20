import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
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

async function startApi(options: { secrets?: boolean; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'screenable-api-'));
  const runtime = join(dir, 'run');
  atomicWrite(join(dir, 'config.json'), JSON.stringify(defaultConfig));
  if (options.secrets !== false) saveSecrets(join(dir, 'secrets.json'), createSecrets(password));
  const port = await freePort();
  const child = spawn(process.execPath, ['dist/api.js'], {
    cwd: process.cwd(), stdio: 'ignore',
    env: { ...process.env, SCREENABLE_STATE_DIR: dir, SCREENABLE_RUN_DIR: runtime, SCREENABLE_PORT: String(port), SCREENABLE_HOST: '127.0.0.1', ...options.env },
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

test('Ausrichtungen werden über die Konfiguration gespeichert', async () => {
  const api = await startApi();
  try {
    const login = await api.login();
    const { csrf } = await login.json() as { csrf: string };
    const headers = { cookie: login.headers.get('set-cookie')!.split(';')[0], 'content-type': 'application/json', 'x-csrf-token': csrf };
    const put = (revision: number, body: unknown) => fetch(`${api.base}/config`, { method: 'PUT', headers: { ...headers, 'if-match': String(revision) }, body: JSON.stringify(body) });
    assert.equal((await put(0, { contentUrl: null, outputId: null, orientations: { 'HDMI-1': 'sideways' } })).status, 400);
    const saved = await (await put(0, { contentUrl: null, outputId: 'HDMI-1', orientations: { 'HDMI-1': 'right' } })).json() as { orientations: unknown };
    assert.deepEqual(saved.orientations, { 'HDMI-1': 'right' });
    // Ältere Dashboards ohne das Feld behalten die gespeicherten Ausrichtungen.
    const kept = await (await put(1, { contentUrl: null, outputId: null })).json() as { orientations: unknown };
    assert.deepEqual(kept.orientations, { 'HDMI-1': 'right' });
    assert.equal((await put(2, { contentUrl: null, outputId: null, resolutions: { 'HDMI-1': '800x600' } })).status, 400);
    const sized = await (await put(2, { contentUrl: null, outputId: null, resolutions: { 'HDMI-1': '3840x2160' } })).json() as { resolutions: unknown; orientations: unknown };
    assert.deepEqual(sized.resolutions, { 'HDMI-1': '3840x2160' });
    assert.deepEqual(sized.orientations, { 'HDMI-1': 'right' });
    const status = await (await fetch(`${api.base}/status`, { headers })).json() as { lte: { present: boolean; bars: number } };
    assert.equal(status.lte.present, false);
    assert.equal(status.lte.bars, 0);
  } finally { await api.stop(); }
});

async function runUpdater(runtime: string, github: string, installer: string, tokenFile: string) {
  const child = spawn(process.execPath, ['dist/updater.js'], {
    cwd: process.cwd(), stdio: 'ignore',
    env: { ...process.env, SCREENABLE_RUN_DIR: runtime, SCREENABLE_GITHUB_API: github, SCREENABLE_INSTALLER: installer, SCREENABLE_GITHUB_TOKEN_FILE: tokenFile },
  });
  const [code] = await once(child, 'exit');
  return code as number | null;
}

test('Over-the-Air-Update: suchen, installieren, Fehler melden', { timeout: 30_000 }, async () => {
  const api = await startApi();
  const releases: { tag: string; auth: string | undefined }[] = [];
  let tag = 'v99.0.0';
  const github = createHttpServer((req, res) => {
    releases.push({ tag, auth: req.headers.authorization });
    if (req.url !== '/repos/screenable/SignagePlayer/releases/latest') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tag_name: tag, name: `Screenable Player ${tag}`, published_at: '2026-10-01T10:00:00Z', body: 'Neue Funktionen', html_url: 'https://github.com/x' }));
  });
  github.listen(0, '127.0.0.1');
  await once(github, 'listening');
  const address = github.address();
  const githubUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    const installer = join(api.dir, 'install.sh');
    writeFileSync(installer, `#!/bin/bash\nprintf '%s %s %s\\n' "$1" "$SCREENABLE_VERSION" "$SCREENABLE_GITHUB_TOKEN" > "${api.dir}/installer-call"\necho 'Lade Screenable Player'\necho 'Fertig.'\nexit "\${FAKE_EXIT:-0}"\n`);
    chmodSync(installer, 0o755);
    const tokenFile = join(api.dir, 'github-token');
    writeFileSync(tokenFile, 'geheim\n');
    const login = await api.login();
    const { csrf } = await login.json() as { csrf: string };
    const headers = { cookie: login.headers.get('set-cookie')!.split(';')[0], 'x-csrf-token': csrf };
    const get = async () => (await fetch(`${api.base}/update`, { headers })).json() as Promise<{ state: string; busy: boolean; latest: { version: string } | null; log: string[]; error: string | null }>;
    const post = (action: string) => fetch(`${api.base}/update/${action}`, { method: 'POST', headers });

    assert.equal((await get()).state, 'idle');
    assert.equal((await fetch(`${api.base}/update/check`, { method: 'POST', headers: { cookie: headers.cookie } })).status, 403);
    assert.equal((await post('install')).status, 409, 'Installieren erst nach einer Prüfung');
    assert.equal((await post('check')).status, 202);
    assert.deepEqual(await get().then(u => [u.state, u.busy]), ['checking', true]);
    assert.equal((await post('check')).status, 409, 'Keine zweite Anforderung, solange eine wartet');

    assert.equal(await runUpdater(api.runtime, githubUrl, installer, tokenFile), 0);
    let update = await get();
    assert.equal(update.state, 'available');
    assert.equal(update.latest?.version, 'v99.0.0');
    assert.equal(releases.at(-1)?.auth, 'Bearer geheim');
    // Erneuter Lauf ohne neue Anforderung tut nichts.
    const calls = releases.length;
    assert.equal(await runUpdater(api.runtime, githubUrl, installer, tokenFile), 0);
    assert.equal(releases.length, calls);

    assert.equal((await post('install')).status, 202);
    assert.equal((await get()).state, 'installing');
    assert.equal(await runUpdater(api.runtime, githubUrl, installer, tokenFile), 0);
    update = await get();
    assert.equal(update.state, 'installed', update.error || '');
    assert.deepEqual(update.log, ['Lade Screenable Player', 'Fertig.']);
    assert.equal(readFileSync(join(api.dir, 'installer-call'), 'utf8').trim(), '--download v99.0.0 geheim');

    // Ein Release, das nicht neuer ist, wird nicht installiert.
    tag = 'v0.0.1';
    assert.equal((await post('check')).status, 202);
    assert.equal(await runUpdater(api.runtime, githubUrl, installer, tokenFile), 0);
    assert.equal((await get()).state, 'up_to_date');
    assert.equal((await post('install')).status, 409);

    // Fehlgeschlagene Installation wird gemeldet.
    tag = 'v99.0.1';
    assert.equal((await post('check')).status, 202);
    assert.equal(await runUpdater(api.runtime, githubUrl, installer, tokenFile), 0);
    assert.equal((await post('install')).status, 202);
    process.env.FAKE_EXIT = '3';
    try { assert.equal(await runUpdater(api.runtime, githubUrl, installer, tokenFile), 0); }
    finally { delete process.env.FAKE_EXIT; }
    update = await get();
    assert.equal(update.state, 'failed');
    assert.match(update.error!, /Code 3/);

    // Ohne erreichbaren Update-Server.
    assert.equal((await post('check')).status, 202);
    assert.equal(await runUpdater(api.runtime, 'http://127.0.0.1:1', installer, tokenFile), 0);
    update = await get();
    assert.equal(update.state, 'failed');
    assert.match(update.error!, /nicht erreichbar/);
  } finally {
    github.close();
    await api.stop();
  }
});

test('Lautstärke und Anwendungsliste', async () => {
  let requests = 0;
  let available = true;
  const lister = createHttpServer((req, res) => {
    requests++;
    if (!available) { res.writeHead(503).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ name: 'Memory', url: 'https://screenable.app/play/memory' }, { name: 'Quiz', url: 'https://screenable.app/play/quiz' }]));
  });
  lister.listen(0, '127.0.0.1');
  await once(lister, 'listening');
  const { port } = lister.address() as { port: number };
  const api = await startApi({ env: { SCREENABLE_APPS_URL: `http://127.0.0.1:${port}/lister2` } });
  try {
    const login = await api.login();
    const { csrf } = await login.json() as { csrf: string };
    const headers = { cookie: login.headers.get('set-cookie')!.split(';')[0], 'content-type': 'application/json', 'x-csrf-token': csrf };
    const volume = (value: unknown) => fetch(`${api.base}/volume`, { method: 'PUT', headers, body: JSON.stringify({ volume: value }) });
    assert.equal((await volume(120)).status, 400);
    const saved = await (await volume(35)).json() as { volume: number; revision: number };
    assert.deepEqual([saved.volume, saved.revision], [35, 1]);
    // Das Formular überschreibt die Lautstärke nicht, wenn es sie nicht mitschickt.
    const form = await (await fetch(`${api.base}/config`, { method: 'PUT', headers: { ...headers, 'if-match': '1' }, body: JSON.stringify({ contentUrl: null, outputId: null }) })).json() as { volume: number };
    assert.equal(form.volume, 35);

    const list = await (await fetch(`${api.base}/apps`, { headers })).json() as { apps: { name: string }[]; error: string | null };
    assert.deepEqual(list.apps.map(a => a.name), ['Memory', 'Quiz']);
    await fetch(`${api.base}/apps`, { headers });
    assert.equal(requests, 1, 'Liste wird zwischengespeichert');
    // Ohne Netz bleibt die zuletzt geladene Liste verfügbar.
    available = false;
    const offline = await (await fetch(`${api.base}/apps?refresh=1`, { headers })).json() as { apps: unknown[]; error: string | null };
    assert.equal(offline.apps.length, 2);
    assert.match(offline.error!, /nicht abrufbar/);
  } finally {
    lister.close();
    await api.stop();
  }
});
