import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModem, signalBars } from '../modem.js';

// Gekürzte Ausgabe von `mmcli -m any --output-json` (ModemManager 1.22, Debian 13).
const connected = {
  modem: {
    '3gpp': { 'operator-name': 'Telekom.de', 'registration-state': 'home' },
    generic: {
      'access-technologies': ['lte'], 'signal-quality': { recent: 'yes', value: '67' },
      state: 'connected', 'state-failed-reason': '--',
    },
  },
};

test('Signalqualität wird in fünf Balken umgerechnet', () => {
  assert.deepEqual([0, 1, 20, 21, 40, 59, 61, 80, 81, 100].map(q => signalBars(q, 'connected')), [0, 1, 1, 2, 2, 3, 4, 4, 5, 5]);
  assert.equal(signalBars(null, 'connected'), 0);
  assert.equal(signalBars(90, 'searching'), 0);
  assert.equal(signalBars(90, 'locked'), 0);
  assert.equal(signalBars(90, 'registered'), 5);
});

test('mmcli-Ausgabe wird gelesen', () => {
  assert.deepEqual(parseModem(JSON.stringify(connected)), {
    present: true, state: 'connected', operator: 'Telekom.de', technology: 'LTE', quality: 67, bars: 4, error: null,
  });
  const locked = { modem: { '3gpp': { 'operator-name': '--' }, generic: { 'access-technologies': [], 'signal-quality': { value: '0' }, state: 'locked', 'state-failed-reason': 'sim-missing' } } };
  assert.deepEqual(parseModem(JSON.stringify(locked)), {
    present: true, state: 'locked', operator: null, technology: null, quality: 0, bars: 0, error: 'sim-missing',
  });
  assert.equal(parseModem('{}').present, false);
});
