import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { availableHdmiPorts, profileFor, routeHdmiAudio, sinkFor, type Card, type Sink } from '../audio.js';

// Intel HDA ohne UCM: je HDMI-Port eigene Profile, analog als Standardprofil.
const acp: Card = {
  name: 'alsa_card.pci-0000_00_1f.3', active_profile: 'output:analog-stereo+input:analog-stereo', properties: { 'alsa.card': '0' },
  profiles: {
    'output:analog-stereo+input:analog-stereo': { priority: 6565, available: true },
    'output:hdmi-stereo': { priority: 5900, available: false },
    'output:hdmi-stereo-extra1': { priority: 5700, available: true },
    'output:hdmi-surround-extra1': { priority: 800, available: true },
    'output:hdmi-stereo-extra1+input:analog-stereo': { priority: 5765, available: true },
  },
  ports: {
    'analog-output-headphones': { description: 'Headphones', availability: 'not available', profiles: ['output:analog-stereo+input:analog-stereo'] },
    'analog-input-mic': { description: 'Microphone', availability: 'not available', profiles: ['output:analog-stereo+input:analog-stereo'] },
    'hdmi-output-0': { description: 'HDMI / DisplayPort', availability: 'not available', profiles: ['output:hdmi-stereo'] },
    'hdmi-output-1': {
      description: 'HDMI / DisplayPort 2', availability: 'available',
      profiles: ['output:hdmi-stereo-extra1', 'output:hdmi-surround-extra1', 'output:hdmi-stereo-extra1+input:analog-stereo'],
    },
  },
};

// Sound Open Firmware mit UCM: ein Profil, je Port ein eigenes Ausgabegerät.
const ucm: Card = {
  name: 'alsa_card.pci-0000_00_1f.3-platform-skl_hda_dsp_generic', active_profile: 'HiFi', properties: { 'alsa.card': '0' },
  profiles: { HiFi: { priority: 8000, available: true } },
  ports: {
    '[Out] Headphones': { description: 'Headphones', availability: 'not available', profiles: ['HiFi'] },
    '[Out] HDMI1': { description: 'HDMI / DisplayPort 1 Output', availability: 'not available', profiles: ['HiFi'] },
    '[Out] HDMI2': { description: 'HDMI / DisplayPort 2 Output', availability: 'available', profiles: ['HiFi'] },
    '[In] Mic': { description: 'Microphone', availability: 'available', profiles: ['HiFi'] },
  },
};

test('Nur verfügbare HDMI-Ausgänge werden gewählt', () => {
  assert.deepEqual(availableHdmiPorts([acp]).map(p => p.port), ['hdmi-output-1']);
  assert.deepEqual(availableHdmiPorts([ucm]).map(p => p.port), ['[Out] HDMI2']);
  const off = { ...ucm, ports: { ...ucm.ports, '[Out] HDMI2': { ...ucm.ports!['[Out] HDMI2'], availability: 'not available' } } };
  assert.deepEqual(availableHdmiPorts([off]), []);
});

test('Profil mit HDMI-Port: aktives behalten, sonst höchste Priorität', () => {
  assert.equal(profileFor(availableHdmiPorts([acp])[0]), 'output:hdmi-stereo-extra1+input:analog-stereo');
  assert.equal(profileFor(availableHdmiPorts([ucm])[0]), 'HiFi');
});

test('Ausgabegerät passt zu Port und Karte', () => {
  const sinks: Sink[] = [
    { name: 'alsa_output.ucm.HiFi__Headphones__sink', active_port: '[Out] Headphones', properties: { 'alsa.card': '0' }, ports: [{ name: '[Out] Headphones' }] },
    { name: 'alsa_output.ucm.HiFi__HDMI2__sink', active_port: '[Out] HDMI2', properties: { 'alsa.card': '0' }, ports: [{ name: '[Out] HDMI2' }] },
    { name: 'alsa_output.usb.HDMI2', active_port: '[Out] HDMI2', properties: { 'alsa.card': '1' } },
  ];
  assert.equal(sinkFor(availableHdmiPorts([ucm])[0], sinks)?.name, 'alsa_output.ucm.HiFi__HDMI2__sink');
});

test('routeHdmiAudio schaltet Profil, Standardgerät, Lautstärke und Stummschaltung', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'screenable-audio-'));
  const path = process.env.PATH;
  try {
    const sinks: Sink[] = [{ name: 'alsa_output.pci-0000_00_1f.3.hdmi-stereo-extra1', mute: true, active_port: 'hdmi-output-1', properties: { 'alsa.card': '0' } }];
    writeFileSync(join(dir, 'cards.json'), JSON.stringify([acp]));
    writeFileSync(join(dir, 'sinks.json'), JSON.stringify(sinks));
    writeFileSync(join(dir, 'pactl'), `#!/bin/sh
case "$*" in
  '--format=json list cards') cat "${dir}/cards.json" ;;
  '--format=json list sinks') cat "${dir}/sinks.json" ;;
  get-default-sink) echo alsa_output.pci-0000_00_1f.3.analog-stereo ;;
  *) echo "$*" >> "${dir}/calls" ;;
esac\n`);
    chmodSync(join(dir, 'pactl'), 0o755);
    process.env.PATH = `${dir}:${path}`;
    const result = await routeHdmiAudio();
    assert.deepEqual(result, { sink: 'alsa_output.pci-0000_00_1f.3.hdmi-stereo-extra1', description: 'HDMI / DisplayPort 2', error: null, changed: true });
    assert.deepEqual(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n'), [
      'set-card-profile alsa_card.pci-0000_00_1f.3 output:hdmi-stereo-extra1+input:analog-stereo',
      'set-default-sink alsa_output.pci-0000_00_1f.3.hdmi-stereo-extra1',
      'set-sink-volume alsa_output.pci-0000_00_1f.3.hdmi-stereo-extra1 100%',
      'set-sink-mute alsa_output.pci-0000_00_1f.3.hdmi-stereo-extra1 0',
    ]);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});
