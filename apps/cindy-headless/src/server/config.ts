/**
 * 通用 Headless 配置与持久状态工具。
 *
 * 这里只放 Node 标准库能力：cindy-headless 必须能在无 Electron/显示服务的
 * 服务器上启动。配置、数据目录和实例锁均限制为 owner-only；未知或新版本的
 * 状态直接报错，不用隐含默认值覆盖。
 */
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, rm, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export interface TailscaleExposureConfig {
  /** Exact MagicDNS name; no scheme or port. */
  hostname: string;
  /** Exact Serve mount path owned by this installation. Serve strips it upstream. */
  path: string;
}

export interface ServerConfig {
  version: 1;
  /** The only listener address this product accepts. */
  host: '127.0.0.1';
  /** 0 lets the OS choose a free loopback port and records it in runtime state. */
  port: number;
  /** Absolute server data root. Tasks and the browser state share this owner runtime. */
  dataDir: string;
  /** Browser clients are never enabled implicitly. */
  webEnabled: boolean;
  /** The only filesystem subtree browser-created tasks may use. Must exist and resolve to a real directory. */
  workspaceRoot: string;
  /** Defaults used when the browser creates a task without an explicit choice. */
  taskDefaults: {
    agentBackend: 'claude-code' | 'codex' | 'pi';
    agentBinaryPath: string;
    model: string;
    provider: string;
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    permissionMode: 'bypassPermissions' | 'acceptEdits' | 'default' | 'ask' | 'auto' | 'plan';
  };
  /** Optional static Web build directory served at the root of the configured Serve path. */
  webRoot?: string;
  /** Optional existing Tailscale Serve route; the server only verifies it and never mutates it. */
  tailscale?: TailscaleExposureConfig;
  /** Named reviewed system prompt file and its SHA-256 at initialization. */
  systemPromptFile?: string;
  systemPromptDigest?: string;
}

const SERVER_CONFIG_FILE = 'server-config.json';

export function serverConfigPath(dataDir: string): string {
  return path.join(dataDir, SERVER_CONFIG_FILE);
}

export function defaultServerConfig(dataDir: string, agentBinaryPath: string): ServerConfig {
  return {
    version: 1,
    host: '127.0.0.1',
    port: 0,
    dataDir: path.resolve(dataDir),
    webEnabled: true,
    workspaceRoot: path.join(path.resolve(dataDir), 'workspaces'),
    taskDefaults: {
      agentBackend: 'claude-code',
      agentBinaryPath,
      model: 'claude-sonnet-4-5',
      provider: 'cindy',
      permissionMode: 'default',
    },
  };
}

function positivePort(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 65_535) {
    throw new Error('port must be an integer between 0 and 65535');
  }
  return value as number;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

export function validateServerConfig(raw: unknown, expectedDataDir?: string): ServerConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('server config must be an object');
  const value = raw as Partial<ServerConfig>;
  if (value.version !== 1) throw new Error('server config version must be 1');
  if (value.host !== '127.0.0.1') throw new Error('server host must be 127.0.0.1; LAN and public binding are not supported');
  const dataDir = path.resolve(nonEmpty(value.dataDir, 'dataDir'));
  if (expectedDataDir && dataDir !== path.resolve(expectedDataDir)) {
    throw new Error('server config dataDir does not match the server data directory');
  }
  if (typeof value.webEnabled !== 'boolean') throw new Error('webEnabled must be boolean');
  const port = positivePort(value.port);
  let tailscale: TailscaleExposureConfig | undefined;
  if (value.tailscale !== undefined) {
    if (!value.tailscale || typeof value.tailscale !== 'object' || Array.isArray(value.tailscale)) {
      throw new Error('tailscale must be an object');
    }
    const hostname = nonEmpty(value.tailscale.hostname, 'tailscale.hostname').toLowerCase().replace(/\.$/, '');
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(hostname)) {
      throw new Error('tailscale.hostname must be an exact *.ts.net MagicDNS name');
    }
    const servePath = nonEmpty(value.tailscale.path, 'tailscale.path');
    if (!/^\/[A-Za-z0-9][A-Za-z0-9._~/-]*$/.test(servePath) || servePath === '/' || servePath.endsWith('/') || servePath.includes('//') || servePath.split('/').includes('..')) {
      throw new Error('tailscale.path must be a non-root absolute path without traversal or a trailing slash');
    }
    if (port === 0) throw new Error('tailscale exposure requires a fixed non-zero port so the Serve target can be verified');
    if (!value.webEnabled) throw new Error('tailscale exposure requires webEnabled=true');
    tailscale = { hostname, path: servePath };
  }
  const workspaceRoot = path.resolve(nonEmpty(value.workspaceRoot, 'workspaceRoot'));
  if (value.webRoot !== undefined && (typeof value.webRoot !== 'string' || !path.isAbsolute(value.webRoot))) {
    throw new Error('webRoot must be an absolute directory');
  }
  const webRoot = value.webRoot === undefined ? undefined : path.resolve(nonEmpty(value.webRoot, 'webRoot'));
  if (webRoot && !value.webEnabled) throw new Error('webRoot requires webEnabled=true');
  if (tailscale && !webRoot) throw new Error('tailscale exposure requires webRoot so the external browser can load the Web client');
  const defaults = value.taskDefaults;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) throw new Error('taskDefaults are required');
  if (!['claude-code', 'codex', 'pi'].includes(defaults.agentBackend ?? '')) throw new Error('taskDefaults.agentBackend is invalid');
  const agentKind = defaults.agentBackend as ServerConfig['taskDefaults']['agentBackend'];
  const agentBinaryPath = path.resolve(nonEmpty(defaults.agentBinaryPath, 'taskDefaults.agentBinaryPath'));
  const model = nonEmpty(defaults.model, 'taskDefaults.model');
  const provider = nonEmpty(defaults.provider, 'taskDefaults.provider');
  if (defaults.effort !== undefined && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(defaults.effort)) {
    throw new Error('taskDefaults.effort is invalid');
  }
  if (!['bypassPermissions', 'acceptEdits', 'default', 'ask', 'auto', 'plan'].includes(defaults.permissionMode ?? '')) {
    throw new Error('taskDefaults.permissionMode is invalid');
  }
  const permissionMode = defaults.permissionMode as ServerConfig['taskDefaults']['permissionMode'];
  if (agentKind === 'pi' && permissionMode !== 'bypassPermissions') {
    throw new Error('pi task default requires bypassPermissions because this server currently has no interactive approval channel');
  }
  if (agentKind === 'codex' && (permissionMode === 'default' || permissionMode === 'acceptEdits')) {
    throw new Error(`codex server does not support ${permissionMode} permission mode`);
  }
  if (agentKind === 'claude-code' && permissionMode === 'auto') {
    throw new Error('claude-code server does not support auto permission mode');
  }
  if (Boolean(value.systemPromptFile) !== Boolean(value.systemPromptDigest)) {
    throw new Error('systemPromptFile and systemPromptDigest must be configured together');
  }
  if (value.systemPromptDigest !== undefined && !/^[a-f0-9]{64}$/.test(value.systemPromptDigest)) {
    throw new Error('systemPromptDigest must be a lowercase sha256 digest');
  }
  return {
    version: 1,
    host: '127.0.0.1',
    port,
    dataDir,
    webEnabled: value.webEnabled,
    workspaceRoot,
    ...(webRoot ? { webRoot } : {}),
    ...(tailscale ? { tailscale } : {}),
    taskDefaults: {
      agentBackend: agentKind,
      agentBinaryPath,
      model,
      provider,
      ...(defaults.effort ? { effort: defaults.effort } : {}),
      permissionMode,
    },
    ...(value.systemPromptFile ? { systemPromptFile: path.resolve(nonEmpty(value.systemPromptFile, 'systemPromptFile')) } : {}),
    ...(value.systemPromptDigest ? { systemPromptDigest: nonEmpty(value.systemPromptDigest, 'systemPromptDigest') } : {}),
  };
}

/** Acquire an exclusive server lock; stale locks are rejected rather than silently stolen. */
export async function acquireServerLock(dataDir: string): Promise<{ release(): Promise<void>; pid: number }> {
  const lockPath = path.join(dataDir, 'server.lock');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  let handle: FileHandle;
  let lockIdentity: { dev: number; ino: number } | undefined;
  try {
    handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existingStat = await stat(lockPath).catch(() => null);
    let previous: { pid?: unknown } | null = null;
    try { previous = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown }; } catch { /* malformed lock is never auto-removed */ }
    if (!existingStat || !previous || !Number.isInteger(previous.pid) || Number(previous.pid) <= 0) {
      throw new Error('server lock exists with unknown owner');
    }
    try {
      process.kill(Number(previous.pid), 0);
      throw new Error('another Cindy headless server instance owns this data directory');
    } catch (probeError) {
      if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
    }
    const currentStat = await stat(lockPath).catch(() => null);
    if (!currentStat || currentStat.dev !== existingStat.dev || currentStat.ino !== existingStat.ino) {
      throw new Error('server lock changed while checking stale owner; retry startup');
    }
    await rm(lockPath);
    return acquireServerLock(dataDir);
  }
  lockIdentity = await handle.stat();
  const payload = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() });
  await handle.writeFile(payload, 'utf8');
  await handle.sync();
  await handle.close();
  let released = false;
  return {
    pid: process.pid,
    async release() {
      if (released) return;
      released = true;
      const currentStat = await stat(lockPath).catch(() => null);
      if (currentStat && lockIdentity && currentStat.dev === lockIdentity.dev && currentStat.ino === lockIdentity.ino) {
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
    },
  };
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
