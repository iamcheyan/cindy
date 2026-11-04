import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ServerConfig } from './config.js';

export type ExposureState = 'disabled' | 'loopback-only' | 'verifying' | 'ready' | 'unavailable' | 'error';

export interface PublicExposure {
  mode: 'loopback' | 'tailscale';
  status: ExposureState;
  url?: string;
  detail: string | null;
}

const execFileAsync = promisify(nodeExecFile);
const STATUS_TIMEOUT_MS = 10_000;
const CACHE_MS = 30_000;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeDnsName(value: string): string {
  return value.toLowerCase().replace(/\.$/, '');
}

function hostPortParts(value: string): { host: string; port: number } | null {
  const split = value.lastIndexOf(':');
  if (split <= 0) return null;
  const port = Number(value.slice(split + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  return { host: normalizeDnsName(value.slice(0, split).replace(/^\[|\]$/g, '')), port };
}

function proxyTargetsLocal(proxy: string, port: number): boolean {
  let raw = proxy.trim();
  if (!raw) return false;
  if (/^\d+$/.test(raw)) raw = `127.0.0.1:${raw}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return false; }
  const targetHost = parsed.hostname.toLowerCase();
  return parsed.protocol === 'http:'
    && (targetHost === '127.0.0.1' || targetHost === 'localhost' || targetHost === '::1' || targetHost === '[::1]')
    && Number(parsed.port || '80') === port
    && (parsed.pathname === '' || parsed.pathname === '/')
    && parsed.search === ''
    && parsed.hash === '';
}

function unavailable(detail: string): PublicExposure {
  return { mode: 'tailscale', status: 'unavailable', detail };
}

function invalid(detail: string): PublicExposure {
  return { mode: 'tailscale', status: 'error', detail };
}

async function readJsonCommand(args: string[]): Promise<Record<string, unknown>> {
  const result = await execFileAsync('tailscale', args, {
    timeout: STATUS_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  const raw = String(result.stdout ?? '').trim();
  let parsed: unknown;
  try { parsed = raw === 'null' ? {} : JSON.parse(raw); } catch { throw new Error('INVALID_TAILSCALE_JSON'); }
  const object = objectValue(parsed);
  if (!object) throw new Error('INVALID_TAILSCALE_JSON');
  return object;
}

function commandFailure(error: unknown): PublicExposure {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'ENOENT') return unavailable('Tailscale CLI is not installed or not on PATH.');
  if (code === 'ETIMEDOUT') return unavailable('Tailscale status check timed out.');
  if (error instanceof Error && error.message === 'INVALID_TAILSCALE_JSON') return invalid('Tailscale returned an unreadable status document.');
  return unavailable('Tailscale status is unavailable.');
}

export class TailnetExposure {
  private cached: { at: number; value: PublicExposure } | null = null;
  private pending: Promise<PublicExposure> | null = null;

  constructor(
    private readonly config: ServerConfig,
    private readonly port: () => number,
  ) {}

  async get(force = false): Promise<PublicExposure> {
    const configured = this.config.tailscale;
    if (!configured) {
      return { mode: 'loopback', status: 'loopback-only', detail: 'Tailscale HTTPS Serve is not configured for this server.' };
    }
    if (!force && this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.value;
    if (this.pending) return this.pending;
    const pending = this.verify(configured).then((value) => {
      this.cached = { at: Date.now(), value };
      return value;
    }).catch(commandFailure).finally(() => { this.pending = null; });
    this.pending = pending;
    return pending;
  }

  private async verify(configured: NonNullable<ServerConfig['tailscale']>): Promise<PublicExposure> {
    const localPort = this.port();
    if (!Number.isInteger(localPort) || localPort <= 0) return unavailable('The local server port is not ready for Serve verification.');
    const status = await readJsonCommand(['status', '--json']);
    if (status.BackendState !== 'Running') return unavailable('Tailscale is not running for this machine.');
    const self = objectValue(status.Self);
    const dnsName = self ? textValue(self.DNSName) : null;
    if (!dnsName || normalizeDnsName(dnsName) !== configured.hostname) {
      return unavailable('The configured Tailscale hostname does not match this machine.');
    }
    const serve = await readJsonCommand(['serve', 'status', '--json']);
    const tcp = objectValue(serve.TCP);
    const httpsHandler = tcp ? objectValue(tcp['443']) : null;
    if (!httpsHandler || httpsHandler.HTTPS !== true) {
      return unavailable('Tailscale Serve is not exposing HTTPS on port 443.');
    }
    const web = objectValue(serve.Web);
    const webEntry = web
      ? Object.entries(web).find(([key]) => {
        const parts = hostPortParts(key);
        return parts?.host === configured.hostname && parts.port === 443;
      })?.[1]
      : null;
    const handlers = webEntry ? objectValue(objectValue(webEntry)?.Handlers) : null;
    const handler = handlers
      ? objectValue(handlers[configured.path] ?? handlers[`${configured.path}/`])
      : null;
    const proxy = handler ? textValue(handler.Proxy) : null;
    if (!handler || !proxy || !proxyTargetsLocal(proxy, localPort)) {
      return unavailable('The configured Serve path does not forward exactly to this loopback server.');
    }
    const allowFunnel = objectValue(serve.AllowFunnel);
    const funnelExact = allowFunnel
      ? Object.entries(allowFunnel).find(([key]) => {
        const parts = hostPortParts(key);
        return parts?.host === configured.hostname && parts.port === 443;
      })?.[1]
      : undefined;
    if (funnelExact === true) return unavailable('Funnel is enabled for the configured host; tailnet-only exposure was not verified.');
    return {
      mode: 'tailscale',
      status: 'ready',
      url: `https://${configured.hostname}${configured.path}/`,
      detail: null,
    };
  }
}

export function isTailnetHost(hostHeader: string | undefined, hostname: string | undefined): boolean {
  if (!hostHeader || !hostname) return false;
  const host = hostHeader.toLowerCase();
  return host === hostname || host === `${hostname}:443`;
}
