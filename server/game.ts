// Game DB queries (AionGame) and GM mail delivery (port of Tools/gm-mail/gm_mail.py).
import { execFile } from 'node:child_process';
import net from 'node:net';
import type { Config } from './config.ts';
import { pool, sql } from './db.ts';
import { loadItems, itemLabel, itemName, baseSlots, isGear, maxEnchant } from './items.ts';
import { LError, type Lang } from './i18n.ts';
import { mailSend } from './cached.ts';

// ---------- service status ----------

function runningProcesses(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10000 }, (err, out) => {
      if (err) return resolve([]);
      resolve(out.split(/\r?\n/).map((l) => l.split('","')[0].replace(/^"/, '')).filter(Boolean));
    });
  });
}

function portOpen(port: number, host = '127.0.0.1', timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const end = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => end(false));
    s.on('connect', () => end(true));
    s.on('error', () => end(false));
  });
}

// `known` = ports whose state we already know without connecting (the in-process GM proxy: a probe connection
// would make it open a real session to the main server every refresh).
export async function serviceStatus(cfg: Config, known: Record<number, boolean> = {}) {
  const procs = (await runningProcesses()).map((p) => p.toLowerCase());
  return Promise.all(cfg.services.map(async (s) => {
    const proc = s.process ? procs.some((p) => p.startsWith(s.process!.toLowerCase())) : null;
    const port = s.port ? (s.port in known ? known[s.port] : await portOpen(s.port)) : null;
    return { name: s.name, process: s.process ?? null, port: s.port ?? null, procRunning: proc, portOpen: port,
      ok: (proc ?? true) && (port ?? true) };
  }));
}

// ---------- characters ----------

const CHAR_COLS = `char_id, user_id, account_id, account_name, race, class, gender, lev, exp, builder, guild_id,
  world, xlocation, ylocation, zlocation, abyss_point, create_date, last_login_time, last_logout_time, playtime, delete_date`;

export async function summary(cfg: Config) {
  const p = await pool(cfg);
  const r = await p.request().query(`
    SELECT COUNT(*) AS chars, COUNT(DISTINCT account_id) AS accounts,
           SUM(CASE WHEN race = 0 THEN 1 ELSE 0 END) AS elyos, SUM(CASE WHEN race = 1 THEN 1 ELSE 0 END) AS asmo,
           SUM(CASE WHEN builder = '1' THEN 1 ELSE 0 END) AS gms
    FROM user_data WHERE delete_date = 0`);
  const recent = await p.request().query(`SELECT TOP 10 ${CHAR_COLS} FROM user_data ORDER BY last_login_time DESC`);
  return { ...r.recordset[0], recent: recent.recordset };
}

export async function listCharacters(cfg: Config) {
  const p = await pool(cfg);
  return (await p.request().query(`SELECT ${CHAR_COLS} FROM user_data ORDER BY char_id`)).recordset;
}

// The cash-item mail CacheD wrote for a shop order (WriteMailByIB: from_name '$$CASH_ITEM_MAIL',
// title '<nameId>, <amount>'): the first one written at/after the order. Used to find gift recipients.
export async function findCashMail(cfg: Config, nameId: number, amount: number, sinceSec: number) {
  const p = await pool(cfg);
  const r = await p.request()
    .input('title', sql.NVarChar(20), `${nameId}, ${amount}`).input('since', sql.Int, sinceSec)
    .query(`SELECT TOP 1 to_id, to_name FROM user_mail
            WHERE from_name = N'$$CASH_ITEM_MAIL' AND title = @title AND arrive_time >= @since ORDER BY arrive_time, id`);
  return r.recordset[0] ? { charId: r.recordset[0].to_id as number, name: r.recordset[0].to_name as string } : null;
}

// One row per game account that has characters on this server (cash points are per account).
export async function listAccounts(cfg: Config): Promise<any[]> {
  const p = await pool(cfg);
  const r = await p.request().query(`
    SELECT account_id, account_name, user_id, race, class, lev, last_login_time
    FROM user_data WHERE delete_date = 0 ORDER BY account_id, lev DESC`);
  const m = new Map<number, any>();
  for (const c of r.recordset) {
    if (!m.has(c.account_id)) m.set(c.account_id, { account_id: c.account_id, account_name: c.account_name, chars: [], last_login_time: null });
    const a = m.get(c.account_id);
    a.chars.push({ name: c.user_id, race: c.race, class: c.class, lev: c.lev });
    if (c.last_login_time && (!a.last_login_time || c.last_login_time > a.last_login_time)) a.last_login_time = c.last_login_time;
  }
  return [...m.values()];
}

export async function getCharacter(cfg: Config, id: number) {
  const p = await pool(cfg);
  const c = await p.request().input('id', sql.Int, id).query(`SELECT ${CHAR_COLS} FROM user_data WHERE char_id = @id`);
  if (!c.recordset.length) return null;
  const items = await p.request().input('id', sql.Int, id).query(`
    SELECT id, name_id, slot_id, amount, slot, warehouse, soul_bound, enchant_count, option_count, proc_tool_nameid,
           stat_enchant_0, stat_enchant_1, stat_enchant_2, stat_enchant_3, stat_enchant_4, stat_enchant_5, create_date
    FROM user_item WHERE char_id = @id ORDER BY warehouse, slot_id`);
  const db = loadItems(cfg.itemsCache);
  for (const it of items.recordset) {
    const info = db.get(it.name_id);
    it.item_name = itemLabel(db, it.name_id);
    it.item_name_en = itemLabel(db, it.name_id, 'en');
    it.quality = info?.quality ?? '';
    it.stones = [0, 1, 2, 3, 4, 5].map((k) => it[`stat_enchant_${k}`]).filter((v: number) => v > 0).length;
    it.sockets = info ? baseSlots(it.name_id, info) + it.option_count : 0;
  }
  return { ...c.recordset[0], items: items.recordset };
}

// ---------- GM mail (items / kinah) ----------

export type MailItem = { id: number; count: number; enchant: number; slots: number | 'max' };
export type MailArgs = {
  to: string[]; items: MailItem[]; money: number; title: string; content: string; sender: string; express: boolean;
  mode?: 'cached' | 'db';   // cached (default): CacheD GQ_MAIL_SEND, online players get it at once; db: direct INSERT, needs relog
  dryRun?: boolean;   // db mode only: run every INSERT, then roll back
};

export function validateMailItems(cfg: Config, items: MailItem[]) {
  const db = loadItems(cfg.itemsCache);
  return items.map((m) => {
    const it = db.get(m.id);
    if (!it) throw new LError(`物品 ${m.id} 在 2.7 的 items.xml 里不存在`, `Item ${m.id} does not exist in the 2.7 items.xml`);
    const zh = itemName(it, 'zh'), en = itemName(it, 'en');
    const count = Math.trunc(m.count || 1), enchant = Math.trunc(m.enchant || 0);
    if (count < 1 || count > it.max_stack) throw new LError(`${zh}：数量 ${count} 超出堆叠上限 ${it.max_stack}`, `${en}: amount ${count} exceeds the stack limit ${it.max_stack}`);
    const gear = isGear(m.id);
    const base = baseSlots(m.id, it);
    const room = Math.max(0, 6 - base);
    let slots = m.slots === 'max' ? Math.min(it.slot_bonus, room) : Math.trunc(Number(m.slots) || 0);
    if (slots && !gear) throw new LError(`${zh} 不是装备，没有魔石孔`, `${en} is not equipment and has no manastone sockets`);
    if (enchant && (!gear || it.no_enchant)) throw new LError(`${zh} 在 2.7 不能强化（只有武器/防具/盾牌可以）`, `${en} cannot be enchanted in 2.7 (only weapons, armor and shields can)`);
    const encMax = maxEnchant(m.id, it);
    if (enchant < 0) throw new LError('强化等级不能为负数', 'The enchant level cannot be negative');
    if (enchant > encMax) throw new LError(`${zh}（${it.quality}）最高只能强化到 +${encMax}` +
      (encMax === 10 ? '：只有唯一（黄）及以上品质才能 +11~+15' : ''),
      `${en} (${it.quality}) can be enchanted to +${encMax} at most` + (encMax === 10 ? ': only unique (yellow) and better can reach +11~+15' : ''));
    if (slots < 0 || slots > room) throw new LError(`${zh}：自带 ${base} 孔 + 额外 ${slots} 孔超过 6 孔`, `${en}: ${base} base + ${slots} extra sockets exceeds 6`);
    if (slots > it.slot_bonus) throw new LError(`${zh}：模板最多只能额外加 ${it.slot_bonus} 孔（option_slot_bonus），不能加 ${slots} 孔`,
      `${en}: the template allows at most ${it.slot_bonus} extra sockets (option_slot_bonus), not ${slots}`);
    return { id: m.id, name: zh, en, count, enchant, slots, sockets: gear ? base + slots : 0 };
  });
}

export async function sendMail(cfg: Config, a: MailArgs) {
  if (!a.to.length) throw new LError('没有选择收件角色', 'No recipient character selected');
  if (!a.items.length && !(a.money > 0)) throw new LError('没有要发送的物品或基纳', 'Nothing to send: no items and no kinah');
  if ([...a.title].length > 20) throw new LError('邮件标题最多 20 个字', 'The mail title can have at most 20 characters');
  if (a.money < 0) throw new LError('基纳不能为负数', 'Kinah cannot be negative');
  const items = validateMailItems(cfg, a.items);
  const p = await pool(cfg);

  const rcpt: Array<{ char_id: number; user_id: string }> = [];
  for (const name of a.to) {
    const r = await p.request().input('n', sql.NVarChar(50), name)
      .query('SELECT char_id, user_id FROM user_data WHERE user_id = @n AND delete_date = 0');
    if (!r.recordset.length) throw new LError(`角色 ${name} 不存在或已删除`, `Character ${name} does not exist or was deleted`);
    rcpt.push(r.recordset[0]);
  }

  // 2.7 mail carries one attachment, so every item is its own mail; kinah rides on the first one.
  const mails = items.length ? items.map((it, k) => ({ it, money: k === 0 ? a.money : 0 })) : [{ it: null, money: a.money }];
  if ((a.mode ?? 'cached') === 'cached' && !a.dryRun) return sendViaCached(cfg, a, rcpt, mails, items);
  const tx = new sql.Transaction(p);
  await tx.begin();
  let sent = 0;
  try {
    for (const c of rcpt) {
      for (const m of mails) {
        let itemDbId = 0, nameId = 0, amount = 0;
        if (m.it) {
          nameId = m.it.id; amount = m.it.count;
          const r = await new sql.Request(tx)
            .input('cid', sql.Int, c.char_id).input('nid', sql.Int, nameId).input('amt', sql.BigInt, amount)
            .input('enc', sql.TinyInt, m.it.enchant).input('opt', sql.TinyInt, m.it.slots)
            .query(`SET NOCOUNT ON;
              INSERT INTO user_item (char_id, name_id, slot_id, amount, slot, warehouse, soul_bound, enchant_count, option_count, proc_tool_nameid)
              VALUES (@cid, @nid, -1, @amt, 0, 5, 0, @enc, @opt, 0);
              SELECT CAST(SCOPE_IDENTITY() AS bigint) AS id`);
          itemDbId = Number(r.recordset[0].id);
        }
        await new sql.Request(tx)
          .input('to', sql.Int, c.char_id).input('toName', sql.NVarChar(50), c.user_id)
          .input('from', sql.NVarChar(50), a.sender || 'GM').input('title', sql.NVarChar(50), a.title || 'GM')
          .input('content', sql.NVarChar(sql.MAX), a.content || '')
          .input('item', sql.BigInt, itemDbId).input('nid', sql.Int, nameId).input('amt', sql.BigInt, amount)
          .input('money', sql.BigInt, m.money).input('express', sql.TinyInt, a.express ? 1 : 0)
          .query(`INSERT INTO user_mail (to_id, to_name, from_id, from_name, title, content, item_id, item_nameid, item_amount, money, state, express_mail)
                  VALUES (@to, @toName, 0, @from, @title, @content, @item, @nid, @amt, @money, 0, @express)`);
        sent++;
      }
    }
    if (a.dryRun) await tx.rollback(); else await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
  return { sent, mode: 'db', dryRun: !!a.dryRun, receivers: rcpt.map((c) => c.user_id), items };
}

type CheckedItem = ReturnType<typeof validateMailItems>[number];

// Real-time delivery through CacheD. Plain items: CacheD creates them (WriteMail_NewItem). Enchanted/extra-socket
// items: we insert the item owned by char 0 ("system"), then GQ_MAIL_SEND with its db id makes CacheD's aion_MailWrite
// move it to the receiver (the GQ handler passes copy-flag 0, so WriteMail does not clone it).
async function sendViaCached(cfg: Config, a: MailArgs, rcpt: Array<{ char_id: number; user_id: string }>,
  mails: Array<{ it: CheckedItem | null; money: number }>, items: CheckedItem[]) {
  const p = await pool(cfg);
  const lastMailId = async (cid: number) =>
    Number((await p.request().input('c', sql.Int, cid).query('SELECT ISNULL(MAX(id), 0) AS id FROM user_mail WHERE to_id = @c')).recordset[0].id);
  const delivered: Array<Record<string, unknown>> = [];
  for (const c of rcpt) {
    for (const m of mails) {
      let templateId = 0;
      if (m.it && (m.it.enchant || m.it.slots)) {
        const r = await p.request()
          .input('nid', sql.Int, m.it.id).input('amt', sql.BigInt, m.it.count)
          .input('enc', sql.TinyInt, m.it.enchant).input('opt', sql.TinyInt, m.it.slots)
          .query(`SET NOCOUNT ON;
            INSERT INTO user_item (char_id, name_id, slot_id, amount, slot, warehouse, soul_bound, enchant_count, option_count, proc_tool_nameid)
            VALUES (0, @nid, -1, @amt, 0, 5, 0, @enc, @opt, 0);
            SELECT CAST(SCOPE_IDENTITY() AS bigint) AS id`);
        templateId = Number(r.recordset[0].id);
      }
      const before = await lastMailId(c.char_id);
      await mailSend(cfg.cached.host, cfg.cached.port, {
        fromId: 0, fromName: a.sender || 'GM', toId: c.char_id, toName: c.user_id, title: a.title || 'GM', content: a.content || '',
        itemDbId: templateId, nameId: m.it?.id ?? 0, amount: m.it?.count ?? 0, money: m.money, express: a.express,
      });
      // CacheD always answers "ok"; confirm the mail row actually appeared (DB work runs on CacheD's DB threads).
      let row: Record<string, unknown> | null = null;
      for (let i = 0; i < 25 && !row; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const q = await p.request().input('c', sql.Int, c.char_id).input('b', sql.Int, before)
          .query(`SELECT TOP 1 m.id, m.item_id, m.item_nameid, m.item_amount, m.money, i.char_id AS item_owner, i.warehouse,
                         i.enchant_count, i.option_count
                  FROM user_mail m LEFT JOIN user_item i ON i.id = m.item_id
                  WHERE m.to_id = @c AND m.id > @b ORDER BY m.id`);
        row = q.recordset[0] ?? null;
      }
      if (!row) {
        if (templateId) await p.request().input('t', sql.BigInt, templateId).query('DELETE FROM user_item WHERE id = @t AND char_id = 0');
        throw new LError(`CacheD 没有为 ${c.user_id} 写入邮件（已发送 ${delivered.length} 封）`, `CacheD did not write the mail for ${c.user_id} (${delivered.length} sent before)`);
      }
      delivered.push({ to: c.user_id, item: m.it?.name ?? null, templateId, ...row });
    }
  }
  return { sent: delivered.length, mode: 'cached', receivers: rcpt.map((c) => c.user_id), items, delivered };
}
