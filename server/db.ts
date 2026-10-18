// SQL Server access over TCP with the pure-JavaScript `mssql` driver (tedious).
// No Docker, WSL, ODBC driver or native module is involved: everything comes from config.json,
// and the password from config.json or an environment variable.
// One pool per database: the game DB (cfg.db.database, AionGame), AionShop and master.
import sql from 'mssql';
import type { Config } from './config.ts';

const pools = new Map<string, Promise<sql.ConnectionPool>>();

export type DbEndpoint = {
  server: string;
  port: number;              // 0 = driver default (1433), or SQL Browser for a named instance
  instanceName: string;
};

// Accepts the forms people use in SSMS and connection strings:
//   127.0.0.1              default instance on the default port
//   127.0.0.1,1433         explicit TCP port
//   127.0.0.1\SQLEXPRESS   named instance (the port is found through SQL Server Browser)
// db.instanceName / db.port are used when they are not already part of db.server.
// A named instance normally uses SQL Browser; an explicit non-default port (or host\INSTANCE,port) wins.
export function parseServer(raw: string, port = 0, instanceName = ''): DbEndpoint {
  let server = String(raw ?? '').trim();
  let p = Number(port) || 0;
  let pFromServer = false;
  let inst = String(instanceName ?? '').trim().replace(/^\\+/, '');

  const comma = server.lastIndexOf(',');
  if (comma > 0) {
    const tail = server.slice(comma + 1).trim();
    if (/^\d{1,5}$/.test(tail)) {
      p = Number(tail);
      pFromServer = true;
      server = server.slice(0, comma).trim();
    }
  }
  const backslash = server.indexOf('\\');
  if (backslash > 0) {
    inst = server.slice(backslash + 1).trim();
    server = server.slice(0, backslash).trim();
  }
  // A named instance plus the default port is what an old config looks like after db.server was changed
  // to host\INSTANCE. Prefer SQL Browser there; an explicit host\INSTANCE,port still wins.
  if (inst && p === 1433 && !pFromServer) p = 0;
  if (!server) throw new Error('db.server is empty');
  if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error(`db.port is invalid: ${port}`);
  return { server, port: p, instanceName: inst };
}

export function endpoint(cfg: Config): DbEndpoint {
  return parseServer(cfg.db.server, cfg.db.port, cfg.db.instanceName);
}

// For logs and error messages; never includes the password.
export function dbTarget(cfg: Config): string {
  const e = endpoint(cfg);
  return `${e.server}${e.instanceName ? '\\' + e.instanceName : ''}${e.port ? ':' + e.port : ''}/${cfg.db.database}`;
}

// The password is never logged. Precedence: db.password, then db.passwordEnv,
// then the usual AION_DB_PASSWORD / MSSQL_SA_PASSWORD / SA_PASSWORD names.
// MSSQL_SA_PASSWORD and SA_PASSWORD are accepted so an existing environment keeps working.
export function resolvePassword(cfg: Config): { password: string; source: string } {
  if (typeof cfg.db.password === 'string' && cfg.db.password) {
    return { password: cfg.db.password, source: 'config.json (db.password)' };
  }
  const configured = String(cfg.db.passwordEnv ?? '').trim();
  const names = ['AION_DB_PASSWORD', 'MSSQL_SA_PASSWORD', 'SA_PASSWORD'];
  if (configured && !names.includes(configured)) names.unshift(configured);
  for (const name of names) {
    const value = process.env[name];
    if (value) return { password: value, source: `environment variable ${name}` };
  }
  throw new Error(`SQL Server password is not set. Put it in config.json as "db.password" or set the environment variable ${names.join(' / ')}.`);
}

function connectionConfig(cfg: Config, database: string, password: string): sql.config {
  const e = endpoint(cfg);
  const options: any = {
    encrypt: cfg.db.encrypt ?? false,
    trustServerCertificate: cfg.db.trustServerCertificate ?? true,
    useUTC: true,                       // the game servers store datetimes in UTC
    enableArithAbort: true,
    appName: 'AionWeb',
  };
  // With a named instance and no explicit port, tedious asks SQL Server Browser (UDP 1434) for the port.
  // Setting port 1433 here would skip that lookup, so only one of the two is passed on.
  if (e.instanceName && !e.port) options.instanceName = e.instanceName;
  const config: sql.config = {
    server: e.server,
    database,
    user: cfg.db.user,
    password,
    connectionTimeout: cfg.db.connectionTimeout ?? 15000,
    requestTimeout: cfg.db.requestTimeout ?? 30000,
    pool: { max: 5, min: 0, idleTimeoutMillis: 60000 },
    options,
  };
  if (e.port) config.port = e.port;
  return config;
}

// Turn the driver's terse errors into something actionable for a Windows install.
function connectionError(e: unknown, cfg: Config): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  const msg = err.message;
  const e2 = endpoint(cfg);
  const where = `${e2.server}${e2.instanceName ? '\\' + e2.instanceName : ''}${e2.port ? ':' + e2.port : ''}`;
  const hints: string[] = [];
  if (/ELOGIN|Login failed/i.test(msg)) {
    hints.push('check db.user/db.password and enable "SQL Server and Windows Authentication mode" in SQL Server properties');
  }
  if (/ECONNREFUSED|ETIMEOUT|ESOCKET|Failed to connect/i.test(msg)) {
    hints.push(`check that SQL Server is running and TCP/IP is enabled for ${where} (SQL Server Configuration Manager -> Protocols for ...)`);
  }
  if (e2.instanceName && /EINSTLOOKUP|SQL Browser|ETIMEOUT|Failed to connect/i.test(msg)) {
    hints.push("check the SQL Server Browser service (UDP 1434) or set db.port to the instance's TCP port");
  }
  if (/EINSTLOOKUP|SQL Browser/i.test(msg) && !e2.instanceName) {
    hints.push('check the instance name in db.server/db.instanceName');
  }
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) hints.push('check the host name in db.server');
  return new Error(hints.length ? `${msg} (${hints.join('; ')})` : msg);
}

export function poolFor(cfg: Config, database: string): Promise<sql.ConnectionPool> {
  let pp = pools.get(database);
  if (!pp) {
    pp = (async () => {
      const { password } = resolvePassword(cfg);
      const p = new sql.ConnectionPool(connectionConfig(cfg, database, password));
      p.on('error', (err: Error) => console.error(`SQL Server pool (${database}) error:`, err.message));
      try {
        await p.connect();
      } catch (e) {
        await p.close().catch(() => {});
        throw connectionError(e, cfg);
      }
      return p;
    })().catch((e) => {
      pools.delete(database);
      throw e;
    });
    pools.set(database, pp);
  }
  return pp;
}

// The game database (AionGame).
export function pool(cfg: Config): Promise<sql.ConnectionPool> {
  return poolFor(cfg, cfg.db.database);
}

export type ConnectionInfo = {
  version: string;
  database: string;
  login: string;
  sysadmin: boolean;
  instance: string | null;
  productVersion: string;
};

// Used by `npm run db:check`; also handy for diagnostics from code.
export async function testConnection(cfg: Config, database = 'master'): Promise<ConnectionInfo> {
  const p = await poolFor(cfg, database);
  const r = await p.request().query(`SELECT @@VERSION AS version, DB_NAME() AS [database], SUSER_SNAME() AS [login],
    IS_SRVROLEMEMBER('sysadmin') AS sysadmin,
    CAST(SERVERPROPERTY('InstanceName') AS nvarchar(128)) AS instance,
    CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS product_version`);
  const row = r.recordset[0];
  return {
    version: String(row.version ?? ''),
    database: String(row.database ?? ''),
    login: String(row.login ?? ''),
    sysadmin: row.sysadmin === 1 || row.sysadmin === true,
    instance: row.instance == null ? null : String(row.instance),
    productVersion: String(row.product_version ?? ''),
  };
}

export async function listDatabases(cfg: Config): Promise<string[]> {
  const p = await poolFor(cfg, 'master');
  const r = await p.request().query(`SELECT name FROM sys.databases ORDER BY name`);
  return r.recordset.map((x: any) => String(x.name));
}

export async function closePools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.allSettled(all.map(async (pp) => {
    try { await (await pp).close(); } catch { /* already closed */ }
  }));
}

export { sql };
