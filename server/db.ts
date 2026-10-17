// SQL Server (WSL docker) access. The sa password is read from the container's env at startup, exactly like
// Tools/gm-mail/gm_mail.py does, so it never has to be written into a config file.
// One pool per database: the game DB (cfg.db.database, AionGame) and our own AionShop.
import { execFile } from 'node:child_process';
import sql from 'mssql';
import type { Config } from './config.ts';

const pools = new Map<string, Promise<sql.ConnectionPool>>();
let passwordPromise: Promise<string> | null = null;

function saPassword(container: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('wsl', ['-e', 'docker', 'inspect', container, '--format', '{{range .Config.Env}}{{println .}}{{end}}'],
      { windowsHide: true, timeout: 20000 }, (err, stdout) => {
        if (err) return reject(new Error(`cannot inspect docker container ${container}: ${err.message}`));
        for (const line of stdout.split(/\r?\n/)) {
          const i = line.indexOf('=');
          const k = line.slice(0, i);
          if (k === 'MSSQL_SA_PASSWORD' || k === 'SA_PASSWORD') return resolve(line.slice(i + 1));
        }
        reject(new Error(`no SA password in the env of container ${container}`));
      });
  });
}

export function poolFor(cfg: Config, database: string): Promise<sql.ConnectionPool> {
  let pp = pools.get(database);
  if (!pp) {
    pp = (async () => {
      if (!passwordPromise) passwordPromise = saPassword(cfg.db.dockerContainer).catch((e) => { passwordPromise = null; throw e; });
      const p = new sql.ConnectionPool({
        server: cfg.db.server,
        port: cfg.db.port,
        database,
        user: cfg.db.user,
        password: await passwordPromise,
        pool: { max: 5, min: 0, idleTimeoutMillis: 60000 },
        // The game servers store datetimes in UTC (verified: a login at 23:31 local time (UTC+8) is stored as 15:31).
        options: { encrypt: false, trustServerCertificate: true, useUTC: true },
      });
      return p.connect();
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

export { sql };
