import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApps } from '../apps.js';

const base = 'https://screenable.app/lister2';

test('Anwendungsliste aus JSON', () => {
  const json = JSON.stringify({
    apps: [
      { title: 'Quiz &amp; Fun', url: 'https://screenable.app/play/quiz#start', description: 'Ratespiel für Wartebereiche' },
      { name: 'Glücksrad', link: '/play/wheel', category: 'Gewinnspiel' },
      { name: 'Unsicher', url: 'http://example.com/' },
      { name: 'Doppelt', url: 'https://screenable.app/play/quiz' },
    ],
    more: ['https://screenable.app/play/memory'],
  });
  assert.deepEqual(parseApps(json, 'application/json', base), [
    { name: 'Glücksrad', url: 'https://screenable.app/play/wheel', description: 'Gewinnspiel' },
    { name: 'Quiz & Fun', url: 'https://screenable.app/play/quiz', description: 'Ratespiel für Wartebereiche' },
    { name: 'screenable.app/play/memory', url: 'https://screenable.app/play/memory', description: null },
  ]);
});

test('Anwendungsliste aus HTML-Links', () => {
  const html = `<!doctype html><html><head><title>x</title><script>var a = '<a href="https://evil.example/">x</a>';</script></head>
    <body><a href="/lister2">Liste</a>
    <ul><li><a class="app" href="https://screenable.app/play/memory"><b>Memory</b> </a></li>
    <li><a href='play/snake' title="Snake"><img src="snake.png"></a></li>
    <li><a href="javascript:alert(1)">Böse</a></li></ul></body></html>`;
  assert.deepEqual(parseApps(html, 'text/html; charset=utf-8', base), [
    { name: 'Memory', url: 'https://screenable.app/play/memory', description: null },
    { name: 'Snake', url: 'https://screenable.app/play/snake', description: null },
  ]);
  assert.deepEqual(parseApps('https://a.example/x\nhttps://b.example/y', 'text/plain', base).map(a => a.url), ['https://a.example/x', 'https://b.example/y']);
});
