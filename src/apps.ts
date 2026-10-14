// Verzeichnis der Screenable-Anwendungen für die URL-Vorschläge im Dashboard. Die
// API lädt es (das Dashboard darf per CSP nur mit dem Gerät sprechen) und hält es
// zwischengespeichert, damit nicht jeder Seitenaufruf LTE-Daten kostet.
import { errorText, log, version } from './log.js';

export type App = { name: string; url: string; description: string | null };

const listUrl = process.env.SCREENABLE_APPS_URL || 'https://screenable.app/lister2';
const CACHE_MS = 15 * 60_000;
const RETRY_MS = 60_000;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_APPS = 1000;
const MAX_TEXT = 300;

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === '#') {
      const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : all;
    }
    return entities[code.toLowerCase()] ?? all;
  });
}

function clean(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const value = decode(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, MAX_TEXT) : null;
}

// Nur Adressen, die der Player auch anzeigen darf: HTTPS, ohne Zugangsdaten; ein
// Fragment wird entfernt.
function contentUrl(value: unknown, base: string): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value.trim(), base);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

function fallbackName(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, '');
  return path ? `${parsed.hostname}${path}` : parsed.hostname;
}

const urlKeys = ['url', 'link', 'href', 'website', 'appUrl', 'app_url', 'playUrl', 'play_url', 'contentUrl', 'content_url'];
const nameKeys = ['name', 'title', 'label', 'appName', 'app_name', 'displayName', 'display_name', 'slug'];
const descriptionKeys = ['description', 'desc', 'subtitle', 'summary', 'category', 'type'];

function pick(entry: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') return entry[key];
  return undefined;
}

// JSON in beliebiger Schachtelung: jedes Objekt mit einem URL-Feld ist eine Anwendung,
// eine Liste aus Zeichenketten eine Liste von Adressen.
function fromJson(data: unknown, base: string): App[] {
  const apps: App[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || apps.length >= MAX_APPS) return;
    if (typeof value === 'string') {
      const url = contentUrl(value, base);
      if (url && /^https:\/\//i.test(value.trim())) apps.push({ name: fallbackName(url), url, description: null });
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (!value || typeof value !== 'object') return;
    const entry = value as Record<string, unknown>;
    const url = contentUrl(pick(entry, urlKeys), base);
    if (url) {
      apps.push({ name: clean(pick(entry, nameKeys)) || fallbackName(url), url, description: clean(pick(entry, descriptionKeys)) });
      return;
    }
    for (const child of Object.values(entry)) if (child && typeof child === 'object') visit(child, depth + 1);
  };
  visit(data, 0);
  return apps;
}

// HTML-Seite: alle Links; Linktext (oder title-Attribut) als Name.
function fromHtml(html: string, base: string): App[] {
  const apps: App[] = [];
  const body = html.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ');
  for (const match of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (apps.length >= MAX_APPS) break;
    const attributes = match[1];
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
    const url = contentUrl(decode(href?.[1] ?? href?.[2] ?? href?.[3] ?? ''), base);
    if (!url) continue;
    const title = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
    apps.push({ name: clean(match[2]) || clean(title?.[1] ?? title?.[2]) || fallbackName(url), url, description: null });
  }
  // Reine Textliste ohne Links.
  if (!apps.length) {
    for (const match of decode(body.replace(/<[^>]*>/g, ' ')).matchAll(/https:\/\/[^\s"'<>]+/g)) {
      const url = contentUrl(match[0], base);
      if (url) apps.push({ name: fallbackName(url), url, description: null });
      if (apps.length >= MAX_APPS) break;
    }
  }
  return apps;
}

export function parseApps(body: string, contentType: string, base = listUrl): App[] {
  const trimmed = body.trim();
  let apps: App[];
  if (/json/i.test(contentType) || /^[[{]/.test(trimmed)) {
    try { apps = fromJson(JSON.parse(trimmed), base); }
    catch { apps = fromHtml(body, base); }
  } else apps = fromHtml(body, base);
  // Doppelte Adressen und Links auf die Liste selbst entfernen.
  const self = contentUrl(base, base);
  const seen = new Set<string>();
  return apps.filter(app => app.url !== self && !seen.has(app.url) && seen.add(app.url))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

async function load(): Promise<App[]> {
  const response = await fetch(listUrl, {
    headers: { accept: 'application/json, text/html;q=0.9, */*;q=0.5', 'user-agent': `screenable-player/${version}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('Liste zu groß');
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Liste zu groß'); }
    chunks.push(value);
  }
  return parseApps(Buffer.concat(chunks).toString('utf8'), response.headers.get('content-type') || '', response.url || listUrl);
}

export type AppList = { source: string; apps: App[]; fetchedAt: string | null; error: string | null };

let cache: { at: number; ok: boolean; list: AppList } | null = null;
let pending: Promise<AppList> | null = null;

export function appList(refresh = false): Promise<AppList> {
  if (cache && !refresh && Date.now() - cache.at < (cache.ok ? CACHE_MS : RETRY_MS)) return Promise.resolve(cache.list);
  pending ??= load()
    .then(apps => {
      cache = { at: Date.now(), ok: true, list: { source: listUrl, apps, fetchedAt: new Date().toISOString(), error: null } };
      return cache.list;
    })
    .catch(error => {
      log('warn', 'app_list_failed', { source: listUrl, error: errorText(error) });
      // Eine früher geladene Liste weiter anbieten, wenn das Netz gerade fehlt.
      const previous = cache?.list;
      cache = {
        at: Date.now(), ok: false,
        list: { source: listUrl, apps: previous?.apps || [], fetchedAt: previous?.fetchedAt || null, error: 'Anwendungsliste nicht abrufbar.' },
      };
      return cache.list;
    })
    .finally(() => { pending = null; });
  return pending;
}
