import { randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecrets, verifyPassword, type Secrets } from './auth.js';
import { atomicWrite, ConflictError, readConfig, saveConfig, ValidationError } from './config.js';
import { errorText, log, version } from './log.js';
import { commandPath, configPath, secretPath, statusPath } from './paths.js';

const SESSION_COOKIE = 'screenable_session';
const SESSION_TTL_MS = 8 * 3600_000;
const MAX_SESSIONS = 50;
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_TRACKED_CLIENTS = 10_000;
const MAX_CONCURRENT_VERIFICATIONS = 2;
const MAX_BODY_BYTES = 16_384;
const STATUS_STALE_MS = 10_000;
const CERT_WARNING_DAYS = 30;

class TooLargeError extends ValidationError {}

const startedAt = Date.now();
const sessions = new Map<string, { csrf: string; expires: number; stamp: string }>();
const attempts = new Map<string, { count: number; reset: number }>();
let verifications = 0;
let secretsCache: { key: string; secrets: Secrets } | null = null;

const webDir = resolve(process.env.SCREENABLE_WEB_DIR || fileURLToPath(new URL('../web/dist/', import.meta.url)));
const certPath = process.env.SCREENABLE_TLS_CERT;
const keyPath = process.env.SCREENABLE_TLS_KEY;
const tls = !!(certPath && keyPath);
const host = process.env.SCREENABLE_HOST || (tls ? '0.0.0.0' : '127.0.0.1');
const port = Number(process.env.SCREENABLE_PORT || (tls ? 8443 : 8080));
if (!tls && host !== '127.0.0.1' && host !== '::1' && process.env.SCREENABLE_ALLOW_HTTP !== '1') {
  throw new Error('HTTP im LAN ist gesperrt. TLS konfigurieren oder HTTP ausdrücklich für ein isoliertes Netz erlauben.');
}

const baseCsp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
// Die Hardware-Testseite erzeugt Audio aus Blob-URLs und Video aus einem Canvas-Stream.
const diagnosticCsp = baseCsp.replace("connect-src 'self'", "connect-src 'self'; media-src 'self' blob: mediastream:");
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function safeEqual(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function clientIp(req: IncomingMessage): string {
  const ip = req.socket.remoteAddress || 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  const part = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  return part?.slice(name.length + 1);
}

function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${tls ? '; Secure' : ''}`;
}

// Secrets werden bei jeder Anmeldung frisch gelesen, sobald sich die Datei ändert.
// So greift `cli.js passwd` ohne API-Neustart und meldet bestehende Sitzungen ab.
function currentSecrets(): Secrets | null {
  let key: string;
  try { const info = statSync(secretPath); key = `${info.ino}:${info.mtimeMs}:${info.size}`; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    secretsCache = null;
    return null;
  }
  if (secretsCache?.key !== key) secretsCache = { key, secrets: readSecrets(secretPath) };
  return secretsCache.secrets;
}

function currentSession(req: IncomingMessage) {
  const id = cookie(req, SESSION_COOKIE);
  if (!id) return null;
  const session = sessions.get(id);
  if (session && session.expires > Date.now() && session.stamp === currentSecrets()?.salt) return { id, ...session };
  sessions.delete(id);
  return null;
}

function requireSession(req: IncomingMessage, res: ServerResponse, write = false) {
  const session = currentSession(req);
  if (!session) { json(res, 401, { error: 'Anmeldung erforderlich.' }); return null; }
  if (write && !safeEqual(req.headers['x-csrf-token'], session.csrf)) {
    json(res, 403, { error: 'Ungültiger CSRF-Token.' }); return null;
  }
  return session;
}

function prune(now = Date.now()): void {
  for (const [id, session] of sessions) if (session.expires <= now) sessions.delete(id);
  for (const [ip, entry] of attempts) if (entry.reset <= now) attempts.delete(ip);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new ValidationError('JSON erwartet.');
  if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) throw new TooLargeError('Anfrage zu groß.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new TooLargeError('Anfrage zu groß.');
    chunks.push(chunk);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ValidationError('JSON-Objekt erwartet.');
  return parsed as Record<string, unknown>;
}

function playerStatus(): Record<string, unknown> {
  try {
    const status = JSON.parse(readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
    if (!status.updatedAt || Date.now() - Date.parse(String(status.updatedAt)) > STATUS_STALE_MS) {
      return { ...status, state: 'offline', lastError: 'Player-Status ist veraltet.' };
    }
    return status;
  }
  catch { return { state: 'unknown', lastError: 'Player-Status nicht verfügbar.' }; }
}

function tlsOptions() {
  return { cert: readFileSync(certPath!), key: readFileSync(keyPath!) };
}

function certificateExpiry(cert: Buffer): Date | null {
  try { return new Date(new X509Certificate(cert).validTo); } catch { return null; }
}

let certValidTo: Date | null = null;
function tlsStatus() {
  if (!certValidTo) return null;
  const daysLeft = Math.floor((certValidTo.getTime() - Date.now()) / 86_400_000);
  return { validTo: certValidTo.toISOString(), daysLeft, expiresSoon: daysLeft < CERT_WARNING_DAYS };
}

async function staticFile(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  let file = resolve(webDir, `.${pathname}`);
  if (file !== webDir && !file.startsWith(webDir + sep)) { json(res, 404, { error: 'Nicht gefunden.' }); return; }
  let info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    // Unbekannte Routen gehen an die Single-Page-App, fehlende Dateien bleiben 404.
    if (extname(pathname)) { json(res, 404, { error: 'Nicht gefunden.' }); return; }
    file = join(webDir, 'index.html');
    info = await stat(file).catch(() => null);
    if (!info?.isFile()) { json(res, 404, { error: 'Nicht gefunden.' }); return; }
  }
  if (pathname === '/diagnostic.html') res.setHeader('content-security-policy', diagnosticCsp);
  res.writeHead(200, {
    'content-type': mime[extname(file)] || 'application/octet-stream',
    'content-length': String(info.size),
    'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(file);
  stream.on('error', error => {
    log('error', 'static_file_error', { path: pathname, error: errorText(error) });
    res.destroy(error);
  });
  stream.pipe(res);
}

async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = clientIp(req);
  const now = Date.now();
  let limit = attempts.get(ip);
  if (!limit || limit.reset <= now) {
    if (attempts.size >= MAX_TRACKED_CLIENTS) prune(now);
    if (attempts.size >= MAX_TRACKED_CLIENTS) attempts.delete(attempts.keys().next().value!);
    limit = { count: 0, reset: now + LOGIN_WINDOW_MS };
    attempts.set(ip, limit);
  }
  if (limit.count >= MAX_LOGIN_ATTEMPTS) {
    res.setHeader('retry-after', String(Math.ceil((limit.reset - now) / 1000)));
    json(res, 429, { error: 'Zu viele Versuche. In 15 Minuten erneut versuchen.' }); return;
  }
  // Vor der asynchronen Prüfung zählen, damit parallele Anfragen das Limit nicht umgehen.
  limit.count++;
  const data = await body(req);
  const secrets = currentSecrets();
  if (!secrets) { json(res, 503, { error: 'Administratorpasswort ist nicht eingerichtet.' }); return; }
  if (verifications >= MAX_CONCURRENT_VERIFICATIONS) {
    res.setHeader('retry-after', '1');
    json(res, 503, { error: 'Anmeldung ausgelastet. Bitte erneut versuchen.' }); return;
  }
  verifications++;
  let valid = false;
  try { valid = typeof data.password === 'string' && await verifyPassword(data.password, secrets); }
  finally { verifications--; }
  if (!valid) {
    log('warn', 'login_failed', { ip, attempts: limit.count });
    json(res, 401, { error: 'Anmeldung fehlgeschlagen.' }); return;
  }
  attempts.delete(ip);
  if (sessions.size >= MAX_SESSIONS) prune();
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  const id = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  sessions.set(id, { csrf, expires: Date.now() + SESSION_TTL_MS, stamp: secrets.salt });
  res.setHeader('set-cookie', sessionCookie(id, SESSION_TTL_MS / 1000));
  log('info', 'login_success', { ip });
  json(res, 200, { loggedIn: true, csrf });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('content-security-policy', baseCsp);
  if (tls) res.setHeader('strict-transport-security', 'max-age=31536000');
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname === '/api/v1/health' && req.method === 'GET') {
    json(res, 200, { ok: true, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }); return;
  }
  if (pathname === '/api/v1/session' && req.method === 'GET') {
    const session = currentSession(req);
    json(res, 200, session ? { loggedIn: true, csrf: session.csrf } : { loggedIn: false }); return;
  }
  if (pathname === '/api/v1/login' && req.method === 'POST') { await login(req, res); return; }
  if (pathname === '/api/v1/logout' && req.method === 'POST') {
    const session = requireSession(req, res, true); if (!session) return;
    sessions.delete(session.id);
    res.setHeader('set-cookie', sessionCookie('', 0));
    log('info', 'logout', { ip: clientIp(req) });
    json(res, 200, { ok: true }); return;
  }
  if (pathname.startsWith('/api/')) {
    const writing = req.method !== 'GET' && req.method !== 'HEAD';
    if (!requireSession(req, res, writing)) return;
    if (pathname === '/api/v1/config' && req.method === 'GET') { json(res, 200, readConfig(configPath)); return; }
    if (pathname === '/api/v1/config' && req.method === 'PUT') {
      const match = req.headers['if-match'];
      if (!match || !/^"?[0-9]+"?$/.test(match.toString())) { json(res, 428, { error: 'If-Match mit Revision erforderlich.' }); return; }
      const current = readConfig(configPath);
      const data = await body(req);
      const updated = saveConfig(configPath, { ...current, outputId: data.outputId, contentUrl: data.contentUrl }, Number(match.toString().replaceAll('"', '')));
      log('info', 'config_updated', { ip: clientIp(req), revision: updated.revision, outputId: updated.outputId, hasContentUrl: !!updated.contentUrl });
      json(res, 200, updated); return;
    }
    if (pathname === '/api/v1/status' && req.method === 'GET') {
      json(res, 200, { version, apiUptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), tls: tlsStatus(), player: playerStatus() }); return;
    }
    if (pathname === '/api/v1/displays' && req.method === 'GET') {
      json(res, 200, { displays: playerStatus().displays || [] }); return;
    }
    if ((pathname === '/api/v1/player/reload' || pathname === '/api/v1/player/restart') && req.method === 'POST') {
      const action = pathname.endsWith('/reload') ? 'reload' : 'restart';
      atomicWrite(commandPath, JSON.stringify({ id: randomUUID(), action, createdAt: Date.now() }) + '\n', 0o640);
      log('info', 'player_command', { ip: clientIp(req), action });
      json(res, 202, { accepted: true }); return;
    }
    json(res, 404, { error: 'Nicht gefunden.' }); return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') { await staticFile(req, res, pathname); return; }
  json(res, 404, { error: 'Nicht gefunden.' });
}

function fail(res: ServerResponse, error: unknown): void {
  if (res.headersSent) { res.destroy(); return; }
  if (error instanceof ConflictError) { json(res, 409, { error: error.message }); return; }
  if (error instanceof TooLargeError) { json(res, 413, { error: error.message }); return; }
  if (error instanceof ValidationError || error instanceof SyntaxError) { json(res, 400, { error: error.message }); return; }
  log('error', 'api_error', { error: errorText(error), stack: error instanceof Error ? error.stack : undefined });
  json(res, 500, { error: 'Interner Fehler.' });
}

const listener = (req: IncomingMessage, res: ServerResponse) => { handle(req, res).catch(error => fail(res, error)); };
const certificate = tls ? tlsOptions() : null;
const server = certificate ? createHttpsServer(certificate, listener) : createHttpServer(listener);
certValidTo = certificate ? certificateExpiry(certificate.cert) : null;
// Langsame oder hängende Clients dürfen keine Verbindungen dauerhaft belegen.
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.on('error', error => { log('error', 'api_listen_failed', { host, port, error: errorText(error) }); process.exit(1); });

if (tls) {
  // Zertifikatstausch ohne Neustart: `systemctl reload screenable-api`.
  process.on('SIGHUP', () => {
    try {
      const next = tlsOptions();
      (server as ReturnType<typeof createHttpsServer>).setSecureContext(next);
      certValidTo = certificateExpiry(next.cert);
      log('info', 'tls_reloaded', { validTo: certValidTo?.toISOString() });
    } catch (error) { log('error', 'tls_reload_failed', { error: errorText(error) }); }
  });
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log('info', 'api_stopping', { signal });
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

setInterval(prune, 60_000).unref();

server.listen(port, host, () => {
  log('info', 'api_listening', { version, host, port, tls });
  const status = tlsStatus();
  if (status?.expiresSoon) log('warn', 'tls_certificate_expiring', status);
  try { if (!currentSecrets()) log('warn', 'admin_password_missing', { hint: 'node dist/cli.js init ausführen' }); }
  catch (error) { log('error', 'secrets_invalid', { error: errorText(error) }); }
});
