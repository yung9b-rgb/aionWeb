// Settings live in config.json (created with defaults on first run); secrets (admin password hash,
// session key) live in data/secrets.json, which is generated and never needs editing by hand.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const SECRETS_PATH = path.join(ROOT, 'data', 'secrets.json');

export type ServiceDef = { name: string; process?: string; port?: number };

// Direct SQL Server connection (no Docker/WSL/ODBC). A dedicated SQL login works too, it does not have to be sa.
export type DbConfig = {
  server: string;                  // 127.0.0.1, 127.0.0.1\SQLEXPRESS or 127.0.0.1,1433
  port: number;                    // 0 = automatic (1433, or SQL Browser for a named instance)
  instanceName: string;            // optional, e.g. SQLEXPRESS
  database: string;                // game database
  user: string;
  password: string;                // optional; leave empty and use an environment variable instead
  passwordEnv: string;             // read when password is empty
  encrypt: boolean;
  trustServerCertificate: boolean;
  connectionTimeout: number;       // ms
  requestTimeout: number;          // ms
};

export type Config = {
  listenHost: string;
  listenPort: number;
  cached: { host: string; port: number };
  db: DbConfig;
  itemsCache: string;
  services: ServiceDef[];
  proxy: { listenHost: string; listenPort: number; targetHost: string; targetPort: number; autoStart: boolean; logPackets: boolean };
  shop: { listenHost: string; listenPort: number; autoStart: boolean };
  shopAgent: { listenHost: string; listenPort: number; autoStart: boolean };
};

const DEFAULTS: Config = {
  listenHost: '127.0.0.1',
  listenPort: 8088,
  cached: { host: '127.0.0.1', port: 2007 },
  db: {
    server: '127.0.0.1',
    port: 0,
    instanceName: '',
    database: 'AionGame',
    user: 'sa',
    password: '',
    passwordEnv: 'AION_DB_PASSWORD',
    encrypt: false,
    trustServerCertificate: true,
    connectionTimeout: 15000,
    requestTimeout: 30000,
  },
  // relative paths are resolved against the AionWeb folder (ROOT); a copy of Tools/gm-mail/items_cache.json
  itemsCache: 'data/items_cache.json',
  services: [
    { name: '认证网关 AuthGateD', process: 'AuthGateD', port: 2106 },
    { name: '认证服务器 L2AuthD', process: 'L2AuthD', port: 2108 },
    { name: '账号缓存 AccountCache', process: 'AccountCacheServer', port: 2220 },
    { name: '缓存服务器 CacheD', process: 'CacheD64', port: 2006 },
    { name: 'CacheD 管理端口', process: 'CacheD64', port: 2007 },
    { name: '主服务器 Server64', process: 'Server64', port: 7777 },
    { name: 'NPC 服务器', process: 'NPCSvr64' },
    { name: '日志服务器', process: 'LogServer64', port: 2051 },
    { name: '聊天服务器', process: 'ChannelChattingServer', port: 10241 },
    { name: 'GM 命令代理', port: 7779 },
  ],
  // GM-command proxy hosted in this process (replaces AionServer/GMProxy/aion_gm_proxy.py)
  proxy: { listenHost: '127.0.0.1', listenPort: 7779, targetHost: '127.0.0.1', targetPort: 7777, autoStart: true, logPackets: false },
  // in-game cash shop catalog server; MainServer/common.xml <shopServerAddr>/<shopServerPort> must point here
  shop: { listenHost: '127.0.0.1', listenPort: 2300, autoStart: true },
  // cash points (and later buy/gift); MainServer/common.xml <shopAgentServerAddr>/<shopAgentServerPort> must point here
  shopAgent: { listenHost: '127.0.0.1', listenPort: 2301, autoStart: true },
};

// File paths in the config may be relative; they are relative to the AionWeb folder, not the working directory.
function resolvePaths(c: Config): Config {
  return { ...c, itemsCache: path.resolve(ROOT, c.itemsCache) };
}

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8');
    return resolvePaths(structuredClone(DEFAULTS));
  }
  const user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return resolvePaths({
    ...DEFAULTS,
    ...user,
    cached: { ...DEFAULTS.cached, ...user.cached },
    db: { ...DEFAULTS.db, ...user.db },
    proxy: { ...DEFAULTS.proxy, ...user.proxy },
    shop: { ...DEFAULTS.shop, ...user.shop },
    shopAgent: { ...DEFAULTS.shopAgent, ...user.shopAgent },
  });
}

export type Secrets = { sessionKey: string; passwordHash?: string };

export function loadSecrets(): Secrets {
  if (fs.existsSync(SECRETS_PATH)) return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
  const s: Secrets = { sessionKey: crypto.randomBytes(32).toString('hex') };
  saveSecrets(s);
  return s;
}

export function saveSecrets(s: Secrets): void {
  fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true });
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(s, null, 2) + '\n', 'utf8');
}
