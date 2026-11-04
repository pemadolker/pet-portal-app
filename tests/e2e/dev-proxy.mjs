// Development stand-in for the Ingress: serves frontend/ and sends /api/* to the
// api-gateway, the same split the Ingress makes in the cluster. Used by the
// browser test (tests/e2e/browser.mjs) when Docker is not available.
//   node tests/e2e/dev-proxy.mjs --port 8088 --gateway http://127.0.0.1:8080

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', 8088));
const GATEWAY = new URL(arg('gateway', 'http://127.0.0.1:8080'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer((req, res) => {
  if (req.url.startsWith('/api/') || req.url === '/api') {
    const up = http.request({ hostname: GATEWAY.hostname, port: GATEWAY.port, path: req.url, method: req.method, headers: { ...req.headers, 'x-real-ip': req.socket.remoteAddress } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end('{"error":"gateway down"}'); });
    req.pipe(up);
    return;
  }
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`frontend on http://127.0.0.1:${PORT}, /api -> ${GATEWAY.href}`));
