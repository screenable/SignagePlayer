import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecrets, verifyPassword } from './auth.js';
import { atomicWrite, ConflictError, readConfig, saveConfig, ValidationError } from './config.js';
import { commandPath, configPath, secretPath, statusPath } from './paths.js';

const startedAt = Date.now();
const sessions = new Map<string, { csrf: string; expires: number }>();
const attempts = new Map<string, { count: number; reset: number }>();
const secrets = readSecrets(secretPath);
const webDir = resolve(process.env.SCREENABLE_WEB_DIR || fileURLToPath(new URL('../web/dist/', import.meta.url)));
const cert = process.env.SCREENABLE_TLS_CERT;
const key = process.env.SCREENABLE_TLS_KEY;
const tls = !!(cert && key);
const host = process.env.SCREENABLE_HOST || (tls ? '0.0.0.0' : '127.0.0.1');
const port = Number(process.env.SCREENABLE_PORT || (tls ? 8443 : 8080));
if (!tls && host !== '127.0.0.1' && host !== '::1' && process.env.SCREENABLE_ALLOW_HTTP !== '1') {
  throw new Error('HTTP im LAN ist gesperrt. TLS konfigurieren oder HTTP ausdrücklich für ein isoliertes Netz erlauben.');
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  const part = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  return part?.slice(name.length + 1);
}

function currentSession(req: IncomingMessage) {
  const id = cookie(req, 'screenable_session');
  const session = id ? sessions.get(id) : undefined;
  if (session && session.expires > Date.now()) return { id: id!, ...session };
  if (id) sessions.delete(id);
  return null;
}

function requireSession(req: IncomingMessage, res: ServerResponse, write = false) {
  const session = currentSession(req);
  if (!session) { json(res, 401, { error: 'Anmeldung erforderlich.' }); return null; }
  if (write && req.headers['x-csrf-token'] !== session.csrf) {
    json(res, 403, { error: 'Ungültiger CSRF-Token.' }); return null;
  }
  return session;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new ValidationError('JSON erwartet.');
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 16_384) throw new ValidationError('Anfrage zu groß.');
  }
  const parsed: unknown = JSON.parse(data);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ValidationError('JSON-Objekt erwartet.');
  return parsed as Record<string, unknown>;
}

function playerStatus(): Record<string, unknown> {
  try {
    const status = JSON.parse(readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
    if (!status.updatedAt || Date.now() - Date.parse(String(status.updatedAt)) > 10_000) {
      return { ...status, state: 'offline', lastError: 'Player-Status ist veraltet.' };
    }
    return status;
  }
  catch { return { state: 'unknown', error: 'Player-Status nicht verfügbar.' }; }
}

function staticFile(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const file = pathname.startsWith('/assets/') || pathname === '/diagnostic.html' || pathname === '/diagnostic.js'
    ? resolve(webDir, `.${pathname}`) : join(webDir, 'index.html');
  if (!file.startsWith(webDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
    json(res, 404, { error: 'Nicht gefunden.' }); return;
  }
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  res.writeHead(200, { 'content-type': `${mime[extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store' });
  createReadStream(file).pipe(res);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  if (tls) res.setHeader('strict-transport-security', 'max-age=31536000');
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname === '/api/v1/health' && req.method === 'GET') {
    json(res, 200, { ok: true, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }); return;
  }
  if (pathname === '/api/v1/session' && req.method === 'GET') {
    const session = currentSession(req);
    json(res, 200, session ? { loggedIn: true, csrf: session.csrf } : { loggedIn: false }); return;
  }
  if (pathname === '/api/v1/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    const limit = attempts.get(ip);
    if (limit && limit.reset > Date.now() && limit.count >= 5) { json(res, 429, { error: 'Zu viele Versuche. In 15 Minuten erneut versuchen.' }); return; }
    const data = await body(req);
    if (typeof data.password !== 'string' || !verifyPassword(data.password, secrets)) {
      attempts.set(ip, { count: limit && limit.reset > Date.now() ? limit.count + 1 : 1, reset: limit && limit.reset > Date.now() ? limit.reset : Date.now() + 900_000 });
      console.warn(JSON.stringify({ event: 'login_failed', ip }));
      json(res, 401, { error: 'Anmeldung fehlgeschlagen.' }); return;
    }
    attempts.delete(ip);
    const id = randomBytes(32).toString('hex');
    const csrf = randomBytes(32).toString('hex');
    sessions.set(id, { csrf, expires: Date.now() + 8 * 3600_000 });
    res.setHeader('set-cookie', `screenable_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${tls ? '; Secure' : ''}`);
    console.info(JSON.stringify({ event: 'login_success', ip }));
    json(res, 200, { loggedIn: true, csrf }); return;
  }
  if (pathname === '/api/v1/logout' && req.method === 'POST') {
    const session = requireSession(req, res, true); if (!session) return;
    sessions.delete(session.id);
    res.setHeader('set-cookie', `screenable_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${tls ? '; Secure' : ''}`);
    json(res, 200, { ok: true }); return;
  }
  if (pathname.startsWith('/api/')) {
    const writing = req.method !== 'GET';
    if (!requireSession(req, res, writing)) return;
    if (pathname === '/api/v1/config' && req.method === 'GET') { json(res, 200, readConfig(configPath)); return; }
    if (pathname === '/api/v1/config' && req.method === 'PUT') {
      const match = req.headers['if-match'];
      if (!match || !/^"?[0-9]+"?$/.test(match.toString())) { json(res, 428, { error: 'If-Match mit Revision erforderlich.' }); return; }
      const current = readConfig(configPath);
      const data = await body(req);
      const updated = saveConfig(configPath, { ...current, outputId: data.outputId, contentUrl: data.contentUrl }, Number(match.toString().replaceAll('"', '')));
      console.info(JSON.stringify({ event: 'config_updated', revision: updated.revision }));
      json(res, 200, updated); return;
    }
    if (pathname === '/api/v1/status' && req.method === 'GET') {
      json(res, 200, { apiUptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), player: playerStatus() }); return;
    }
    if (pathname === '/api/v1/displays' && req.method === 'GET') {
      json(res, 200, { displays: playerStatus().displays || [] }); return;
    }
    if ((pathname === '/api/v1/player/reload' || pathname === '/api/v1/player/restart') && req.method === 'POST') {
      const action = pathname.endsWith('/reload') ? 'reload' : 'restart';
      atomicWrite(commandPath, JSON.stringify({ id: randomUUID(), action, createdAt: Date.now() }) + '\n', 0o640);
      console.info(JSON.stringify({ event: 'player_command', action }));
      json(res, 202, { accepted: true }); return;
    }
    json(res, 404, { error: 'Nicht gefunden.' }); return;
  }
  if (req.method === 'GET') { staticFile(req, res, pathname); return; }
  json(res, 404, { error: 'Nicht gefunden.' });
}

const server = tls
  ? createHttpsServer({ cert: readFileSync(cert!), key: readFileSync(key!) }, (req, res) => { handle(req, res).catch(error => fail(res, error)); })
  : createHttpServer((req, res) => { handle(req, res).catch(error => fail(res, error)); });

function fail(res: ServerResponse, error: unknown): void {
  if (res.headersSent) { res.destroy(); return; }
  if (error instanceof ConflictError) { json(res, 409, { error: error.message }); return; }
  if (error instanceof ValidationError || error instanceof SyntaxError) { json(res, 400, { error: error.message }); return; }
  console.error(JSON.stringify({ event: 'api_error', error: String(error) }));
  json(res, 500, { error: 'Interner Fehler.' });
}

server.listen(port, host, () => console.info(JSON.stringify({ event: 'api_listening', host, port, tls })));
