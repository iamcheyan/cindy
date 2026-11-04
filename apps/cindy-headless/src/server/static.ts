import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const ALLOWED_EXTENSIONS = new Set(Object.keys(CONTENT_TYPES));
const STATIC_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cache-Control': 'no-store',
};

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end('Not found');
}

/** Serves only the reviewed Web client build files; API, hidden and source-map paths never match. */
export class StaticWebFiles {
  private root: string | null = null;

  constructor(private readonly configuredRoot: string | undefined) {}

  async init(): Promise<void> {
    const configuredRoot = this.configuredRoot;
    if (!configuredRoot) return;
    const root = await realpath(configuredRoot);
    for (const required of ['index.html', 'app.js', 'app.css']) {
      const file = await realpath(path.join(root, required));
      if (!within(root, file)) throw new Error(`webRoot ${required} escapes the configured directory`);
      const info = await stat(file);
      if (!info.isFile()) throw new Error(`webRoot ${required} is not a file`);
    }
    this.root = root;
  }

  async handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
    const root = this.root;
    if (!root) return false;
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    if (pathname.startsWith('/api/')) return false;
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Bad request'); return true; }
    if (decoded.includes('\0') || decoded.includes('\\')) { notFound(response); return true; }
    const segments = decoded.split('/').filter(Boolean);
    if (segments.some((segment) => segment === '..' || segment === '.')) { notFound(response); return true; }
    const relative = segments.length === 0 ? 'index.html' : segments.join('/');
    const candidate = path.resolve(root, relative);
    if (!within(root, candidate)) { notFound(response); return true; }
    const extension = path.extname(candidate).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) { notFound(response); return true; }
    const resolved = await realpath(candidate).catch(() => null);
    if (!resolved || !within(root, resolved)) { notFound(response); return true; }
    const info = await stat(resolved).catch(() => null);
    if (!info?.isFile()) { notFound(response); return true; }
    const headers = { ...STATIC_HEADERS, 'Content-Type': CONTENT_TYPES[extension]!, 'Content-Length': String(info.size) };
    response.writeHead(200, headers);
    if (request.method === 'HEAD') { response.end(); return true; }
    const stream = createReadStream(resolved);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
    return true;
  }
}
