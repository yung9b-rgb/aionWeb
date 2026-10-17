// Aion admin web server: static pages from public/, JSON API under /api, single-admin login.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, loadSecrets, saveSecrets } from './config.ts';
import { COOKIE, hashPassword, verifyPassword, issueToken, verifyToken, parseCookies, sessionCookie, clearCookie } from './auth.ts';
import { announce } from './cached.ts';
import { serviceStatus, summary, listCharacters, getCharacter, sendMail, validateMailItems, listAccounts, findCashMail } from './game.ts';
import { loadItems, searchItems } from './items.ts';
import { GmProxy } from './gmproxy.ts';
import { ShopServer } from './shopserver.ts';
import { ShopAgentServer } from './shopagent.ts';
import { ShopDb, SHOP_DB } from './shopdb.ts';

const cfg = loadConfig();
const secrets = loadSecrets();
const proxy = new GmProxy({ ...cfg.proxy, logDir: path.join(ROOT, 'data', 'proxy_logs') });
proxy.logPackets = cfg.proxy.logPackets;
// Shop data (points, orders, catalog) and the admin log live in our own AionShop database.
const shopDb = new ShopDb(cfg);
let shopDbError: string | null = null;     // set if AionShop could not be created/opened at startup
const shop = new ShopServer(cfg.shop.listenHost, cfg.shop.listenPort, shopDb);
// BuyItem only carries nameId/amount/price, so goods name and duration come from the catalog we serve.
const agent = new ShopAgentServer(cfg.shopAgent.listenHost, cfg.shopAgent.listenPort, shopDb, async (nameId, price) => {
  const goods = (await shop.loadCatalog()).goods.filter((g) => g.gameItemKey === nameId);
  const g = goods.find((x) => x.salePrice === price) ?? goods[0];
  return g ? { goodsId: g.goodsId, goodsName: g.goodsName, itemDuration: g.itemDuration } : null;
});
const PUBLIC = path.join(ROOT, 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject', '.map': 'application/json',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'expected application/json');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > 256 * 1024) throw new HttpError(413, 'request too large');
    chunks.push(c);
  }
  let body: any;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'bad JSON'); }
  (req as any).__body = body;
  return body;
}

// ---- admin log: every state-changing request is recorded in AionShop.admin_log ----
const AUDIT: Record<string, string> = {
  '/api/setup': 'setup', '/api/login': 'login', '/api/logout': 'logout', '/api/announce': 'announce', '/api/mail': 'mail',
  '/api/proxy/start': 'proxy_start', '/api/proxy/stop': 'proxy_stop', '/api/proxy/options': 'proxy_options', '/api/proxy/clear': 'proxy_clear',
  '/api/shop/catalog': 'catalog_save', '/api/shop/push': 'catalog_push', '/api/shop/start': 'shop_start',
  '/api/points/start': 'points_start', '/api/points/change': 'points_change',
};
function auditTarget(action: string, b: any): string | null {
  if (!b) return null;
  if (action === 'mail') return (Array.isArray(b.to) ? b.to.join(',') : null);
  if (action === 'points_change') return b.accountId != null ? `账号 ${b.accountId}` : null;
  if (action === 'announce') return String(b.text ?? '').slice(0, 100);
  if (action === 'catalog_save') return `分类 ${b.categories?.length ?? 0}、商品 ${b.goods?.length ?? 0}`;
  return null;
}
function audit(req: http.IncomingMessage, pathname: string, ok: boolean, message: string | null) {
  const action = AUDIT[pathname];
  if (!action || shopDbError) return;
  const body = (req as any).__body;
  const detail = body && typeof body === 'object' ? { ...body } : body;
  if (detail && typeof detail === 'object') for (const k of Object.keys(detail)) if (/password/i.test(k)) detail[k] = '***';
  shopDb.adminLog({ action, target: auditTarget(action, body), detail, ok, message, remoteAddr: req.socket.remoteAddress ?? null })
    .catch((e) => console.error('admin_log write failed:', e.message));
}

const failures: number[] = [];
function tooManyFailures(): boolean {
  const now = Date.now();
  while (failures.length && failures[0] < now - 60_000) failures.shift();
  return failures.length >= 5;
}

type Handler = (req: http.IncomingMessage, url: URL, m: RegExpMatchArray) => Promise<unknown>;
const routes: Array<{ method: string; re: RegExp; open?: boolean; h: Handler }> = [];
const route = (method: string, pattern: string, h: Handler, open = false) =>
  routes.push({ method, re: new RegExp(`^${pattern}$`), h, open });

// ---- auth ----
route('GET', '/api/session', async (req) => ({
  authed: verifyToken(secrets.sessionKey, parseCookies(req.headers.cookie)[COOKIE]),
  needsSetup: !secrets.passwordHash,
}), true);

route('POST', '/api/setup', async (req) => {
  if (secrets.passwordHash) throw new HttpError(409, '管理密码已经设置过了');
  const { password } = await readJson(req);
  if (typeof password !== 'string' || password.length < 6) throw new HttpError(400, '密码至少 6 位');
  secrets.passwordHash = hashPassword(password);
  saveSecrets(secrets);
  return { ok: true, __cookie: sessionCookie(issueToken(secrets.sessionKey)) };
}, true);

route('POST', '/api/login', async (req) => {
  if (tooManyFailures()) throw new HttpError(429, '尝试次数过多，请 1 分钟后再试');
  const { password } = await readJson(req);
  if (!secrets.passwordHash) throw new HttpError(409, '请先设置管理密码');
  if (typeof password !== 'string' || !verifyPassword(password, secrets.passwordHash)) {
    failures.push(Date.now());
    throw new HttpError(401, '密码错误');
  }
  return { ok: true, __cookie: sessionCookie(issueToken(secrets.sessionKey)) };
}, true);

route('POST', '/api/logout', async () => ({ ok: true, __cookie: clearCookie }), true);

// ---- dashboard ----
route('GET', '/api/status', async () => {
  const [services, sum] = await Promise.all([
    serviceStatus(cfg, proxy.running ? { [cfg.proxy.listenPort]: true } : {}),
    summary(cfg).catch((e: Error) => ({ error: e.message })),
  ]);
  return { services, summary: sum, cached: `${cfg.cached.host}:${cfg.cached.port}` };
});

// ---- announce (CacheD GQ_ANNOUNCE) ----
route('POST', '/api/announce', async (req) => {
  const b = await readJson(req);
  const position = b.position === 'C' ? 'C' : 'M';
  const category = b.category === 'E' ? 'E' : 'A';
  const raceMask = Number.isInteger(b.raceMask) ? b.raceMask : -1;
  const classMask = Number.isInteger(b.classMask) ? b.classMask : -1;
  if (raceMask === 0 || classMask === 0) throw new HttpError(400, '至少选择一个种族和一个职业（全不选等于谁都收不到）');
  const rep = await announce(cfg.cached.host, cfg.cached.port, { text: String(b.text ?? ''), position, category, raceMask, classMask });
  if (rep.result !== 0) throw new HttpError(502, `CacheD 返回错误码 ${rep.result}`);
  return { ok: true };
});

// ---- characters ----
route('GET', '/api/characters', async () => listCharacters(cfg));
route('GET', '/api/characters/(\\d+)', async (_req, _url, m) => {
  const c = await getCharacter(cfg, Number(m[1]));
  if (!c) throw new HttpError(404, '角色不存在');
  return c;
});

// ---- items / mail ----
route('GET', '/api/items', async (_req, url) => searchItems(loadItems(cfg.itemsCache), url.searchParams.get('q') ?? ''));
// Batch lookup by item id (shop editor shows names / max stack for the goods it lists).
route('GET', '/api/items/info', async (_req, url) => {
  const db = loadItems(cfg.itemsCache);
  const ids = (url.searchParams.get('ids') ?? '').split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 2000);
  return Object.fromEntries(ids.map((id) => {
    const it = db.get(id);
    return [id, it ? { zh: it.zh || it.name, name: it.name, max_stack: it.max_stack, quality: it.quality, level: it.level } : null];
  }));
});

route('POST', '/api/mail/preview', async (req) => {
  const b = await readJson(req);
  return validateMailItems(cfg, Array.isArray(b.items) ? b.items : []);
});

route('POST', '/api/mail', async (req) => {
  const b = await readJson(req);
  return sendMail(cfg, {
    to: (Array.isArray(b.to) ? b.to : []).map((s: unknown) => String(s).trim()).filter(Boolean),
    items: Array.isArray(b.items) ? b.items : [],
    money: Math.trunc(Number(b.money) || 0),
    title: String(b.title ?? 'GM'), content: String(b.content ?? ''), sender: String(b.sender ?? 'GM'),
    express: b.express !== false,
    mode: b.mode === 'db' ? 'db' : 'cached',
  });
});

// ---- GM-command proxy ----
const proxyStatus = () => ({
  running: proxy.running, startedAt: proxy.startedAt, clients: proxy.clients, commands: proxy.commands,
  listen: `${cfg.proxy.listenHost}:${cfg.proxy.listenPort}`, target: `${cfg.proxy.targetHost}:${cfg.proxy.targetPort}`,
  logPackets: proxy.logPackets, error: proxy.lastError,
});
route('GET', '/api/proxy/status', async () => proxyStatus());
route('POST', '/api/proxy/start', async () => {
  try { await proxy.start(); } catch (e: any) { throw new HttpError(409, e.message); }
  return proxyStatus();
});
route('POST', '/api/proxy/stop', async () => { await proxy.stop(); return proxyStatus(); });
route('POST', '/api/proxy/options', async (req) => {
  const b = await readJson(req);
  if (typeof b.logPackets === 'boolean') proxy.logPackets = b.logPackets;
  return proxyStatus();
});
route('GET', '/api/proxy/logs', async (_req, url) => {
  const since = Number(url.searchParams.get('since')) || 0;
  const lines = proxy.logsSince(since, url.searchParams.get('all') === '1');
  return { lines: lines.slice(-1000), last: lines.length ? lines[lines.length - 1].seq : since };
});
route('POST', '/api/proxy/clear', async () => { proxy.clearLogs(); return { ok: true }; });

// ---- in-game cash shop catalog server ----
const shopStatus = () => ({
  running: shop.running, connections: shop.connections, serverId: shop.serverId, lastSync: shop.lastSync,
  listen: `${cfg.shop.listenHost}:${cfg.shop.listenPort}`, error: shopDbError ? `数据库 ${SHOP_DB} 不可用：${shopDbError}` : shop.lastError,
});
route('GET', '/api/shop/status', async () => shopStatus());
route('GET', '/api/shop/catalog', async () => shop.loadCatalog());
// Server-side checks for a catalog before it replaces the old one (the game memcpy's fixed-size structs:
// names <= 50 chars, description <= 200; ranking panel has 6 slots; the tabs + 目录 UI is two levels deep).
function validateCatalog(b: any): string[] {
  const errs: string[] = [];
  const items = loadItems(cfg.itemsCache);
  const isInt = (v: any, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  const cats = new Map<number, any>();
  for (const c of b.categories) {
    if (!isInt(c.categoryId, 1, 0x7fffffff)) { errs.push(`分类编号不对：${c.categoryId}`); continue; }
    if (cats.has(c.categoryId)) errs.push(`分类编号重复：${c.categoryId}`);
    cats.set(c.categoryId, c);
    if (typeof c.categoryName !== 'string' || !c.categoryName.trim() || c.categoryName.length > 50) errs.push(`分类 ${c.categoryId} 的名称要 1~50 个字`);
    if (!isInt(c.displayOrder ?? 0, -32768, 32767)) errs.push(`分类 ${c.categoryId} 的排序值不对`);
  }
  for (const c of cats.values()) {
    const pid = c.parentId ?? 0;
    if (pid === 0) continue;
    const parent = cats.get(pid);
    if (!parent) errs.push(`分类「${c.categoryName}」的上级分类 ${pid} 不存在`);
    else if ((parent.parentId ?? 0) !== 0) errs.push(`分类「${c.categoryName}」：最多两级（页签 → 目录）`);
  }
  const goods = new Set<number>();
  for (const g of b.goods) {
    const label = `商品 ${g.goodsId}「${g.goodsName ?? ''}」`;
    if (!isInt(g.goodsId, 1, 0x7fffffff)) { errs.push(`商品编号不对：${g.goodsId}`); continue; }
    if (goods.has(g.goodsId)) errs.push(`商品编号重复：${g.goodsId}`);
    goods.add(g.goodsId);
    if (typeof g.goodsName !== 'string' || !g.goodsName.trim() || g.goodsName.length > 50) errs.push(`${label}：名称要 1~50 个字`);
    if (typeof (g.desc ?? '') !== 'string' || (g.desc ?? '').length > 200) errs.push(`${label}：描述最多 200 个字`);
    if (!isInt(g.salePrice, 0, 0x7fffffff)) errs.push(`${label}：价格要是 0 以上的整数`);
    if (!isInt(g.itemDuration ?? 0, 0, 0x7fffffff)) errs.push(`${label}：有效期不对`);
    const it = items.get(g.gameItemKey);
    if (!it) errs.push(`${label}：物品编号 ${g.gameItemKey} 不存在`);
    const maxStack = Math.max(1, it?.max_stack ?? 1);
    if (!isInt(g.itemAmount, 1, 0x7fff)) errs.push(`${label}：每份数量要是 1 以上的整数`);
    else if (it && g.itemAmount > maxStack) errs.push(`${label}：每份数量 ${g.itemAmount} 超过这个物品的最大堆叠 ${maxStack}`);
    const seen = new Set<number>();
    for (const gc of g.categories ?? []) {
      if (!cats.has(gc.categoryId)) errs.push(`${label}：分类 ${gc.categoryId} 不存在`);
      if (seen.has(gc.categoryId)) errs.push(`${label}：重复放进分类 ${gc.categoryId}`);
      seen.add(gc.categoryId);
    }
  }
  const slots = new Set<string>();
  for (const r of b.rankings ?? []) {
    if (!isInt(r.ranking, 1, 6)) errs.push(`推荐榜位置要在 1~6：${r.ranking}`);
    const k = `${r.rankingTypeCode ?? 1}:${r.ranking}`;
    if (slots.has(k)) errs.push(`推荐榜位置 ${r.ranking} 重复`);
    slots.add(k);
    if (!goods.has(r.goodsId)) errs.push(`推荐榜位置 ${r.ranking} 的商品 ${r.goodsId} 不存在`);
  }
  return errs;
}

route('POST', '/api/shop/catalog', async (req) => {
  const b = await readJson(req);
  if (!b || !Array.isArray(b.categories) || !Array.isArray(b.goods)) throw new HttpError(400, '目录格式不对：需要 categories 和 goods 数组');
  const errs = validateCatalog(b);
  if (errs.length) throw new HttpError(400, `目录有 ${errs.length} 处问题，未保存：\n` + errs.slice(0, 20).join('\n'));
  try { await shop.saveCatalog(b); } catch (e: any) { throw new HttpError(400, `保存失败，目录未改动：${e.message}`); }
  return { ok: true, notified: shop.notifyUpdate() };
});
route('POST', '/api/shop/push', async () => ({ ok: true, notified: shop.notifyUpdate() }));
route('POST', '/api/shop/start', async () => {
  if (shopDbError) throw new HttpError(409, `数据库 ${SHOP_DB} 不可用：${shopDbError}`);
  try { await shop.start(); } catch (e: any) { throw new HttpError(409, e.message); }
  return shopStatus();
});
route('GET', '/api/shop/logs', async (_req, url) => {
  const since = Number(url.searchParams.get('since')) || 0;
  const lines = shop.logsSince(since);
  return { lines, last: lines.length ? lines[lines.length - 1].seq : since };
});

// ---- in-game cash shop points (shop agent) ----
const agentStatus = () => ({
  running: agent.running, connections: agent.connections, serverId: agent.serverId,
  listen: `${cfg.shopAgent.listenHost}:${cfg.shopAgent.listenPort}`, db: SHOP_DB,
  error: shopDbError ? `数据库 ${SHOP_DB} 不可用：${shopDbError}` : agent.lastError,
});
route('GET', '/api/points/status', async () => agentStatus());
route('POST', '/api/points/start', async () => {
  if (shopDbError) throw new HttpError(409, `数据库 ${SHOP_DB} 不可用：${shopDbError}`);
  try { await agent.start(); } catch (e: any) { throw new HttpError(409, e.message); }
  return agentStatus();
});
route('GET', '/api/points/accounts', async () => {
  const bal = await shopDb.allBalances();
  const rows = await listAccounts(cfg);
  const seen = new Set(rows.map((r: any) => String(r.account_id)));
  for (const id of Object.keys(bal)) if (!seen.has(id)) rows.push({ account_id: Number(id), account_name: null, chars: [] });
  for (const r of rows) r.points = bal[r.account_id] ?? 0;
  return rows;
});
route('POST', '/api/points/change', async (req) => {
  const b = await readJson(req);
  const accountId = Number(b.accountId), delta = Number(b.delta);
  const reason = String(b.reason ?? '').trim().slice(0, 100) || (delta > 0 ? '后台充值' : '后台扣除');
  const accountName = typeof b.accountName === 'string' && b.accountName ? b.accountName.slice(0, 32) : null;
  try { return { ok: true, ...(await agent.change(accountId, delta, reason, accountName)) }; } catch (e: any) { throw new HttpError(400, e.message); }
});
agent.mailLookup = (o) => findCashMail(cfg, o.itemNameId, o.itemAmount, Math.floor(o.t / 1000) - 5);
route('GET', '/api/points/orders', async () => shopDb.listOrders());
route('GET', '/api/points/history', async (_req, url) => {
  const id = url.searchParams.get('accountId');
  return shopDb.history(id ? Number(id) : undefined);
});
route('GET', '/api/points/logs', async (_req, url) => {
  const since = Number(url.searchParams.get('since')) || 0;
  const lines = agent.logsSince(since);
  return { lines, last: lines.length ? lines[lines.length - 1].seq : since };
});

// ---- admin log ----
route('GET', '/api/adminlog', async (_req, url) => {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 1000);
  return shopDb.listAdminLog(limit, url.searchParams.get('action') || undefined);
});

// ---- static files ----
function serveStatic(res: http.ServerResponse, pathname: string) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': file.includes(`${path.sep}vendors${path.sep}`) ? 'max-age=86400' : 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  if (!r) return send(res, 404, { error: 'no such API' });
  try {
    if (!r.open && !verifyToken(secrets.sessionKey, parseCookies(req.headers.cookie)[COOKIE])) throw new HttpError(401, '请先登录');
    const out: any = await r.h(req, url, url.pathname.match(r.re)!);
    const cookie = out && typeof out === 'object' && '__cookie' in out ? out.__cookie : null;
    if (cookie) delete out.__cookie;
    if (req.method === 'POST') audit(req, url.pathname, true, null);
    send(res, 200, out, cookie ? { 'Set-Cookie': cookie } : {});
  } catch (e: any) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(new Date().toISOString(), req.method, url.pathname, e);
    if (req.method === 'POST' && status !== 401) audit(req, url.pathname, false, e?.message ?? String(e));
    send(res, status, { error: e?.message ?? String(e) });
  }
});

server.listen(cfg.listenPort, cfg.listenHost, () => {
  console.log(`Aion 管理后台已启动: http://${cfg.listenHost}:${cfg.listenPort}/`);
  console.log(`CacheD 管理端口: ${cfg.cached.host}:${cfg.cached.port}   数据库: ${cfg.db.server}:${cfg.db.port}/${cfg.db.database}`);
  if (!secrets.passwordHash) console.log('首次使用：打开网页后先设置管理密码。');
  if (cfg.proxy.autoStart) {
    proxy.start()
      .then(() => console.log(`GM 命令代理已启动: ${cfg.proxy.listenHost}:${cfg.proxy.listenPort} -> ${cfg.proxy.targetHost}:${cfg.proxy.targetPort}`))
      .catch((e: Error) => console.log(`GM 命令代理未启动: ${e.message}`));
  }
  // The shop services need AionShop: create/upgrade it (and import the old JSON files once) before starting them.
  (async () => {
    try {
      for (const n of await shopDb.ensure()) console.log(n);
      for (const n of await shopDb.importJson(path.join(ROOT, 'data'))) console.log(`已从 JSON 导入 ${SHOP_DB}：${n}`);
      console.log(`数据库 ${SHOP_DB} 就绪`);
    } catch (e: any) {
      shopDbError = e.message;
      console.log(`数据库 ${SHOP_DB} 不可用，商城和点券服务不启动：${e.message}`);
      return;
    }
    if (cfg.shop.autoStart) {
      shop.start()
        .then(() => console.log(`商城服务器已启动: ${cfg.shop.listenHost}:${cfg.shop.listenPort}`))
        .catch((e: Error) => console.log(`商城服务器未启动: ${e.message}`));
    }
    if (cfg.shopAgent.autoStart) {
      agent.start()
        .then(() => console.log(`点券服务已启动: ${cfg.shopAgent.listenHost}:${cfg.shopAgent.listenPort}`))
        .catch((e: Error) => console.log(`点券服务未启动: ${e.message}`));
    }
    agent.backfillRecipients().catch(() => {});
  })();
});
