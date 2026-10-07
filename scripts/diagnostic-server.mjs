import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';

const root = process.env.SCREENABLE_WEB_DIR || '/opt/screenable-player/current/web/dist';
const files = {
  '/diagnostic.html': ['diagnostic.html', 'text/html; charset=utf-8'],
  '/diagnostic.css': ['diagnostic.css', 'text/css; charset=utf-8'],
  '/diagnostic.js': ['diagnostic.js', 'text/javascript; charset=utf-8'],
};
createServer((req, res) => {
  const entry = files[new URL(req.url || '/', 'http://localhost').pathname];
  if (!entry) { res.writeHead(404); res.end(); return; }
  const stream = createReadStream(join(root, entry[0]));
  stream.on('error', () => { res.writeHead(404); res.end(); });
  stream.on('open', () => { res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' }); stream.pipe(res); });
}).listen(8090, '127.0.0.1', () => console.log('Diagnoseseite: http://localhost:8090/diagnostic.html'));
