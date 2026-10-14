import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Ausschnitt aus `pactl --format=json list cards|sinks` (PipeWire-Pulse oder PulseAudio).
export type CardPort = { description?: string; availability?: string; profiles?: string[] };
export type Card = {
  name: string; active_profile?: string; properties?: Record<string, string>;
  profiles?: Record<string, { priority?: number; available?: boolean }>;
  ports?: Record<string, CardPort>;
};
export type Sink = { name: string; mute?: boolean; active_port?: string | null; properties?: Record<string, string>; ports?: { name: string }[] };
export type HdmiPort = { card: Card; port: string; description: string };

const HDMI = /hdmi|displayport/i;

// HDMI-Ports mit angeschlossenem, audiofähigem Gerät (ELD gemeldet). xrandr schaltet
// alle anderen Ausgänge ab; deren Ports melden dann „not available“. Damit gehört
// der verfügbare Port zum gewählten Bildausgang.
export function availableHdmiPorts(cards: Card[]): HdmiPort[] {
  return cards.flatMap(card => Object.entries(card.ports || {}).flatMap(([port, info]) => {
    const description = info.description || port;
    // UCM-Eingänge heißen „[In] …“, ACP-Eingänge „…-input-…“.
    if (/^\[In\]|input/i.test(port) || !HDMI.test(`${port} ${description}`)) return [];
    return info.availability === 'available' ? [{ card, port, description }] : [];
  }));
}

// Profil, das den Port enthält: das aktive, sonst das höchstpriorisierte verfügbare.
export function profileFor(target: HdmiPort): string | null {
  const names = target.card.ports?.[target.port]?.profiles || [];
  if (target.card.active_profile && names.includes(target.card.active_profile)) return target.card.active_profile;
  const profiles = target.card.profiles || {};
  return names
    .filter(name => profiles[name]?.available !== false)
    .sort((a, b) => (profiles[b]?.priority || 0) - (profiles[a]?.priority || 0))[0] || null;
}

export function sinkFor(target: HdmiPort, sinks: Sink[]): Sink | null {
  const cardId = target.card.properties?.['alsa.card'];
  const sameCard = (sink: Sink) => !cardId || !sink.properties?.['alsa.card'] || sink.properties['alsa.card'] === cardId;
  return sinks.find(sink => sameCard(sink) && sink.active_port === target.port)
    || sinks.find(sink => sameCard(sink) && sink.ports?.length === 1 && sink.ports[0].name === target.port)
    || null;
}

async function pactl(...args: string[]): Promise<string> {
  const { stdout } = await exec('pactl', args, { timeout: 5000 });
  return stdout;
}

export type AudioResult = { sink: string | null; description: string | null; error: string | null; changed: boolean };

// Leitet die Tonausgabe auf den HDMI-Port des aktiven Bildausgangs. Chromium spielt auf
// das Standardgerät; WirePlumber verschiebt laufende Streams beim Wechsel automatisch.
export async function routeHdmiAudio(): Promise<AudioResult> {
  const cards = JSON.parse(await pactl('--format=json', 'list', 'cards')) as Card[];
  const target = availableHdmiPorts(cards)[0];
  if (!target) return { sink: null, description: null, error: 'Kein HDMI-Audiogerät verfügbar (Monitor ohne Lautsprecher oder getrennt).', changed: false };
  let changed = false;
  const profile = profileFor(target);
  if (!profile) return { sink: null, description: target.description, error: `Kein Profil für ${target.port}.`, changed };
  if (profile !== target.card.active_profile) {
    await pactl('set-card-profile', target.card.name, profile);
    changed = true;
  }
  const sinks = JSON.parse(await pactl('--format=json', 'list', 'sinks')) as Sink[];
  const sink = sinkFor(target, sinks);
  if (!sink) return { sink: null, description: target.description, error: `Kein Ausgabegerät für ${target.port}.`, changed };
  const current = (await pactl('get-default-sink')).trim();
  if (current !== sink.name) {
    await pactl('set-default-sink', sink.name);
    // Signage hat keine Lautstärkeregelung am Gerät: einmalig voll aufdrehen.
    await pactl('set-sink-volume', sink.name, '100%');
    changed = true;
  }
  if (sink.mute) { await pactl('set-sink-mute', sink.name, '0'); changed = true; }
  return { sink: sink.name, description: target.description, error: null, changed };
}
