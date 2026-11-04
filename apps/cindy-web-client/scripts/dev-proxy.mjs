/**
 * Local-only development proxy for the browser client.
 *
 * The headless server currently exposes only loopback JSON/SSE APIs and does not
 * serve the static Web bundle. This proxy serves `dist/` and forwards `/api/*`
 * to the loopback server so cookies, CSRF, Origin and SSE behave as same-origin
 * during local integration. It binds 127.0.0.1 only and must not be exposed to
 * a LAN or tailnet.
 *
 * Usage:
 *   node scripts/dev-proxy.mjs --port 5173 --api http://127.0.0.1:<server-port>
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(root, '..', 'dist');
const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

const port = Number(value('--port') ?? 5173);
const api = new URL(value('--api') ?? 'http://127.0.0.1:8787');
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port must be a valid TCP port');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname) || api.protocol !== 'http:') {
  throw new Error('--api must be an http:// loopback URL');
}
if (api.pathname !== '/' || api.search || api.hash) throw new Error('--api must not contain a path, query or fragment');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function proxy(request, response) {
  const target = new URL(request.url ?? '/', api);
  const headers = { ...request.headers };
  headers.host = api.host;
  headers.origin = api.origin;
  delete headers['x-forwarded-for'];
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];
  const upstream = http.request(
    {
      protocol: 'http:',
      hostname: api.hostname,
      port: api.port,
      path: `${target.pathname}${target.search}`,
      method: request.method,
      headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on('error', () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: { code: 'PROXY_UNAVAILABLE', message: 'The Cindy server is not reachable.' } }));
  });
  request.pipe(upstream);
}

async function serveStatic(request, response) {
  const rawPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const relative = rawPath === '/' ? 'index.html' : decodeURIComponent(rawPath).replace(/^\/+/, '');
  const file = path.resolve(dist, relative);
  if (file !== dist && !file.startsWith(`${dist}${path.sep}`)) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
    return;
  }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  createReadStream(file).pipe(response);
}

const server = http.createServer((request, response) => {
  if ((request.url ?? '').startsWith('/api/')) {
    proxy(request, response);
    return;
  }
  void serveStatic(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Static file error');
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ ok: true, state: 'listening', url: `http://127.0.0.1:${port}/`, api: api.origin, staticDir: dist }));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
