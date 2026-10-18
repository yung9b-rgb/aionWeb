// `npm run db:check` - verifies the SQL Server settings in config.json without starting the admin panel.
// It connects with the same code the admin uses (pure JS `mssql`, no Docker/WSL/ODBC) and prints what it found.
import { loadConfig } from '../server/config.ts';
import { closePools, dbTarget, endpoint, listDatabases, poolFor, resolvePassword, testConnection } from '../server/db.ts';
import { SHOP_DB } from '../server/shopdb.ts';

const cfg = loadConfig();
const e = endpoint(cfg);
console.log('AionWeb database check');
console.log(`  target   : ${dbTarget(cfg)}`);
console.log(`  instance : ${e.instanceName || '(default)'}${e.port ? `, TCP port ${e.port}` : ', TCP port automatic'}`);
console.log(`  login    : ${cfg.db.user}`);

try {
  const { source } = resolvePassword(cfg);
  console.log(`  password : ${source}`);

  const info = await testConnection(cfg, 'master');
  const version = info.version.split(/\r?\n/)[0].trim();
  console.log(`\nConnected: ${version}`);
  console.log(`  server instance : ${info.instance ?? '(default)'}`);
  console.log(`  login           : ${info.login}${info.sysadmin ? ' (sysadmin)' : ''}`);
  console.log(`  product version : ${info.productVersion}`);

  const databases = await listDatabases(cfg);
  console.log(`  databases       : ${databases.join(', ')}`);

  const game = await poolFor(cfg, cfg.db.database);
  const probe = await game.request().query(`SELECT DB_NAME() AS [database],
    CASE WHEN OBJECT_ID('dbo.user_data') IS NULL THEN 0 ELSE 1 END AS has_user_data`);
  const row = probe.recordset[0];
  console.log(`\nGame DB ${cfg.db.database}: connected`);
  if (Number(row.has_user_data) === 1) console.log('  table dbo.user_data: found');
  else console.log('  table dbo.user_data: NOT found - check that db.database is the Aion game database');
  console.log(`AionShop: ${databases.includes(SHOP_DB) ? 'present' : 'not created yet (the admin creates it on first start)'}`);
  console.log('\nOK');
} catch (err: any) {
  console.error(`\nFAILED: ${err?.message ?? err}`);
  if (/password is not set/i.test(String(err?.message))) {
    console.error('Set db.password in config.json or the AION_DB_PASSWORD environment variable, then run again.');
  }
  process.exitCode = 1;
} finally {
  await closePools();
}
