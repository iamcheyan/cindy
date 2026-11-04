import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createWebServer, type WebServerHandle } from './http.js';
import { acquireServerLock, defaultServerConfig, serverConfigPath, sha256, validateServerConfig } from './config.js';
import { ServerRuntime } from './runtime.js';
import { HeadlessStore } from './store.js';

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function dataDirectory(args: string[]): string {
  const configured = value(args, '--data-dir') ?? process.env.CINDY_HEADLESS_DATA_DIR;
  if (configured !== undefined && configured.trim() === '') throw new Error('--data-dir must not be empty');
  const base = configured ?? path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'cindy-headless');
  return path.resolve(base);
}

async function readConfig(dataDir: string) {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(serverConfigPath(dataDir), 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('server is not initialized; run `cindy-headless server init` first');
    throw new Error('server config is unreadable or invalid JSON');
  }
  return validateServerConfig(raw, dataDir);
}

async function initialize(args: string[]): Promise<void> {
  const dataDir = dataDirectory(args);
  const agentBinaryPath = value(args, '--agent-binary');
  if (!agentBinaryPath || !path.isAbsolute(agentBinaryPath)) throw new Error('server init requires --agent-binary <absolute-path>');
  const agentBackend = value(args, '--agent') ?? 'claude-code';
  if (!['claude-code', 'codex', 'pi'].includes(agentBackend)) throw new Error('--agent must be claude-code, codex, or pi');
  const permissionMode = value(args, '--permission-mode')
    ?? (agentBackend === 'pi' ? 'bypassPermissions' : agentBackend === 'codex' ? 'plan' : 'default');
  if (agentBackend === 'pi' && permissionMode === 'bypassPermissions' && process.env.CINDY_HEADLESS_ALLOW_UNSANDBOXED_BYPASS !== '1') {
    throw new Error('Pi headless server needs an actual sandbox profile; plain server mode cannot claim containerSandbox. Use a sandboxed deployment or set CINDY_HEADLESS_ALLOW_UNSANDBOXED_BYPASS=1 only for a controlled owner machine');
  }
  const systemPromptFile = value(args, '--system-prompt');
  if (!systemPromptFile || !path.isAbsolute(systemPromptFile)) throw new Error('server init requires --system-prompt <absolute-path>; use a reviewed Cindy production prompt');
  const systemPrompt = await readFile(systemPromptFile, 'utf8');
  const config = defaultServerConfig(dataDir, agentBinaryPath);
  config.systemPromptFile = systemPromptFile;
  config.systemPromptDigest = sha256(systemPrompt);
  config.taskDefaults.agentBackend = agentBackend as typeof config.taskDefaults.agentBackend;
  config.taskDefaults.model = value(args, '--model') ?? config.taskDefaults.model;
  config.taskDefaults.provider = value(args, '--provider') ?? config.taskDefaults.provider;
  config.taskDefaults.permissionMode = permissionMode as typeof config.taskDefaults.permissionMode;
  config.taskDefaults.effort = value(args, '--effort') as typeof config.taskDefaults.effort;
  config.port = Number(value(args, '--port') ?? 0);
  config.workspaceRoot = path.resolve(value(args, '--workspace-root') ?? config.workspaceRoot);
  const webRoot = value(args, '--web-root');
  if (webRoot) {
    if (!path.isAbsolute(webRoot)) throw new Error('--web-root must be an absolute directory');
    await readFile(path.join(webRoot, 'index.html'), 'utf8');
    config.webRoot = path.resolve(webRoot);
  }
  const tailscaleHostname = value(args, '--tailscale-hostname');
  const tailscalePath = value(args, '--tailscale-path');
  if (Boolean(tailscaleHostname) !== Boolean(tailscalePath)) {
    throw new Error('--tailscale-hostname and --tailscale-path must be provided together');
  }
  if (tailscaleHostname && tailscalePath) {
    config.tailscale = { hostname: tailscaleHostname.trim().toLowerCase(), path: tailscalePath.trim() };
  }
  const validated = validateServerConfig(config, dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  await mkdir(validated.workspaceRoot, { recursive: true, mode: 0o700 });
  const configFile = serverConfigPath(dataDir);
  try {
    await writeFile(configFile, JSON.stringify(validated, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('server config already exists; refusing to overwrite it');
    throw error;
  }
  await chmod(configFile, 0o600);
  console.log(JSON.stringify({ ok: true, command: 'server init', config: path.basename(configFile), webEnabled: validated.webEnabled, host: validated.host, port: validated.port }));
}

async function serve(dataDir: string): Promise<void> {
  let lock: { release(): Promise<void>; pid: number } | undefined;
  let runtime: ServerRuntime | undefined;
  let web: WebServerHandle | undefined;
  let stopping = false;
  let receivedSignal: NodeJS.Signals | undefined;
  const stopped = Promise.withResolvers<NodeJS.Signals>();
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    receivedSignal = signal;
    stopped.resolve(signal);
  };
  const onSigint = () => stop('SIGINT');
  const onSigterm = () => stop('SIGTERM');
  const reportStopping = () => {
    if (receivedSignal) console.log(JSON.stringify({ ok: true, state: 'stopping', signal: receivedSignal }));
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const config = await readConfig(dataDir);
    if (stopping) { reportStopping(); return; }
    if (!config.webEnabled) throw new Error('webEnabled is false in server config');
    try {
      lock = await acquireServerLock(dataDir);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new Error(`${error.message}; if the recorded process is unquestionably gone, inspect and remove the server.lock file manually`);
    }
    if (stopping) { reportStopping(); return; }
    runtime = await ServerRuntime.start(config, dataDir);
    if (stopping) { reportStopping(); return; }
    web = await createWebServer({ runtime, config, store: runtime.store });
    if (stopping) { reportStopping(); return; }
    const address = web.server.address();
    const port = address && typeof address === 'object' ? address.port : config.port;
    const exposure = await web.exposure.get();
    console.log(JSON.stringify({ ok: true, state: 'listening', host: '127.0.0.1', port, exposure }));
    const signal = await stopped.promise;
    console.log(JSON.stringify({ ok: true, state: 'stopping', signal }));
  } finally {
    try { await web?.close(); } finally {
      try { await runtime?.close(); } finally {
        try { await lock?.release(); } finally {
          process.off('SIGINT', onSigint);
          process.off('SIGTERM', onSigterm);
        }
      }
    }
  }
}

async function withStore<T>(dataDir: string, action: (store: HeadlessStore) => T | Promise<T>): Promise<T> {
  const config = await readConfig(dataDir);
  const store = await HeadlessStore.open(config.dataDir);
  try { return await action(store); } finally { store.close(); }
}

async function clientCommand(args: string[], dataDir: string): Promise<void> {
  const action = args[1];
  if (action === 'pending') {
    await withStore(dataDir, (store) => {
      const rows = store.listAllPendingClients();
      console.log(JSON.stringify(rows.map((row) => ({ request: row.id.slice(0, 12), label: row.label, expiresAt: row.expiresAt, approved: Boolean(row.approvedAt), redeemed: Boolean(row.redeemedAt) }))));
    });
    return;
  }
  if (action === 'approve') {
    const prefix = args[2];
    if (!prefix || !/^[a-f0-9]{8,64}$/i.test(prefix)) throw new Error('server clients approve requires a pending request prefix');
    await withStore(dataDir, (store) => {
      const matches = store.listAllPendingClients().filter((row) => row.id.startsWith(prefix.toLowerCase()));
      if (matches.length !== 1) throw new Error(matches.length ? 'request prefix is ambiguous' : 'pending request not found or expired');
      const clientId = randomUUID();
      const approved = store.approvePendingClient(matches[0]!.id, clientId);
      if (!approved) throw new Error('request was already approved, redeemed, or expired');
      console.log(JSON.stringify({ ok: true, clientId, label: approved.label }));
    });
    return;
  }
  if (action === 'list') {
    await withStore(dataDir, (store) => console.log(JSON.stringify(store.listClients().map(({ id, label, createdAt, lastSeenAt, revokedAt }) => ({ id, label, createdAt, lastSeenAt, revokedAt })))));
    return;
  }
  if (action === 'revoke') {
    const id = args[2];
    if (!id) throw new Error('server clients revoke requires a client id');
    await withStore(dataDir, (store) => {
      const client = store.revokeClient(id);
      if (!client) throw new Error('client not found');
      store.revokeClientSessions(id);
      console.log(JSON.stringify({ ok: true, clientId: id, revokedAt: client.revokedAt }));
    });
    return;
  }
  if (action === 'revoke-all') {
    await withStore(dataDir, (store) => {
      const count = store.revokeAllClients();
      for (const client of store.listClients()) store.revokeClientSessions(client.id);
      console.log(JSON.stringify({ ok: true, revokedClients: count }));
    });
    return;
  }
  throw new Error('server clients commands: pending, approve <request-prefix>, list, revoke <client-id>, revoke-all');
}

export async function runServerCommand(args: string[]): Promise<boolean> {
  if (args[0] !== 'server') return false;
  process.umask(0o077);
  const action = args[1] ?? 'help';
  const dataDir = dataDirectory(args);
  if (action === 'init') await initialize(args);
  else if (action === 'serve') await serve(dataDir);
  else if (action === 'clients') await clientCommand(args.slice(1), dataDir);
  else throw new Error('server commands: init, serve, clients pending|approve|list|revoke|revoke-all');
  return true;
}
