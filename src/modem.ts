import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { errorText, log } from './log.js';

const exec = promisify(execFile);
const CACHE_MS = 10_000;
const TIMEOUT_MS = 5000;

export type Lte = {
  present: boolean;
  // ModemManager-Zustand, z. B. connected, registered, searching, locked, disabled.
  state: string | null;
  operator: string | null;
  technology: string | null;
  quality: number | null;
  bars: number;
  error: string | null;
};

const none = (error: string | null = null): Lte => ({ present: false, state: null, operator: null, technology: null, quality: null, bars: 0, error });

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value !== '--' ? value : null;
}

// Signalqualität 0–100 % in fünf Balken. Ohne Netzregistrierung zählt das Signal
// nicht, auch wenn das Modem noch einen alten Wert meldet.
export function signalBars(quality: number | null, state: string | null): number {
  if (quality === null || quality <= 0) return 0;
  if (state && ['failed', 'unknown', 'initializing', 'locked', 'disabled', 'disabling', 'enabling', 'searching'].includes(state)) return 0;
  return Math.min(5, Math.ceil(quality / 20));
}

// Ausgabe von `mmcli -m any --output-json`.
export function parseModem(json: string): Lte {
  const modem = (JSON.parse(json) as { modem?: Record<string, Record<string, unknown>> }).modem;
  if (!modem) return none();
  const generic = modem.generic || {};
  const gpp = modem['3gpp'] || {};
  const state = text(generic.state);
  const raw = Number((generic['signal-quality'] as { value?: unknown } | undefined)?.value);
  const quality = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : null;
  const technologies = Array.isArray(generic['access-technologies']) ? generic['access-technologies'].filter(t => typeof t === 'string') : [];
  return {
    present: true,
    state,
    operator: text(gpp['operator-name']),
    technology: technologies.length ? technologies.join(', ').toUpperCase() : null,
    quality,
    bars: signalBars(quality, state),
    error: text(generic['state-failed-reason']),
  };
}

async function query(): Promise<Lte> {
  try {
    const { stdout } = await exec('mmcli', ['-m', 'any', '--output-json'], { timeout: TIMEOUT_MS });
    return parseModem(stdout);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') return none('ModemManager (mmcli) ist nicht installiert.');
    // Ohne Modem meldet mmcli einen Fehler; das ist kein Problem des Dashboards.
    if (/couldn't find|not found|no modems/i.test(err.stderr || '')) return none();
    log('warn', 'modem_query_failed', { error: (err.stderr || errorText(error)).trim() });
    return none('Modemstatus nicht abrufbar.');
  }
}

let cache: { at: number; value: Lte } | null = null;
let pending: Promise<Lte> | null = null;

// Mehrere Dashboards fragen alle fünf Sekunden; mmcli läuft höchstens alle zehn.
export function lteStatus(): Promise<Lte> {
  if (cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.value);
  pending ??= query().then(value => { cache = { at: Date.now(), value }; return value; }).finally(() => { pending = null; });
  return pending;
}
