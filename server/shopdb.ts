// AionShop: our own database (same SQL Server as the game) for the in-game cash shop and the admin.
//   points:   account_point (one row per account, balance) + point_ledger (append-only history)
//   catalog:  shop_category, shop_goods, shop_goods_category, shop_ranking (hand-maintained), shop_promotion
//   orders:   shop_order (one row per BuyItem, order_id = the warehouseId Server64 keys its pending items on)
//   admin:    admin_log (every admin action)
//   meta:     schema_meta (schema version, one-time JSON import marker)
// Kept out of AionGame on purpose: the game DB belongs to the game servers. All times are UTC (datetime2).
// Lessons taken from NCsoft's AionSADB.Warehouse: buyer and recipient stored separately, a unique request key
// against double processing, server_id on every row, an index on status for the redelivery query.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { poolFor, sql } from './db.ts';
import { LError } from './i18n.ts';
import type { ShopCatalog, ShopGoods } from './shopserver.ts';

export const SHOP_DB = 'AionShop';
const SCHEMA_VERSION = '1';

export type PointEntry = { t: number; accountId: number; delta: number; balance: number; reason: string; kind: string; operator: string; orderId: number | null };
export type ShopOrder = {
  warehouseId: number; status: 'paid' | 'delivered' | 'refunded'; t: number; deliveredAt?: number; redelivered?: number;
  accountId: number; charId: number; charName: string; itemNameId: number; itemAmount: number; durationSec: number;
  price: number; goodsName: string; goodsId?: number | null;
  recipientCharId?: number; recipientName?: string; recipientChecked?: boolean;
};
export type BuyRequest = {
  requestKey: string; serverId: number; accountId: number; charId: number; charName: string;
  itemNameId: number; itemAmount: number; durationSec: number; price: number; priceCategory: number; priceId: number;
  goodsId: number | null; goodsName: string;
};
export type AdminLogEntry = { action: string; target?: string | null; detail?: unknown; ok?: boolean; message?: string | null; remoteAddr?: string | null };

// Each entry is one batch (no GO). Every statement is idempotent so this runs on every start.
export const SCHEMA: string[] = [
  `IF OBJECT_ID('dbo.schema_meta') IS NULL CREATE TABLE dbo.schema_meta (
     k nvarchar(64) NOT NULL CONSTRAINT PK_schema_meta PRIMARY KEY,
     v nvarchar(400) NOT NULL,
     updated_at datetime2(3) NOT NULL CONSTRAINT DF_schema_meta_updated DEFAULT SYSUTCDATETIME())`,

  `IF OBJECT_ID('dbo.account_point') IS NULL CREATE TABLE dbo.account_point (
     account_id int NOT NULL CONSTRAINT PK_account_point PRIMARY KEY,
     account_name nvarchar(32) NULL,
     balance bigint NOT NULL CONSTRAINT DF_account_point_balance DEFAULT 0 CONSTRAINT CK_account_point_balance CHECK (balance >= 0),
     updated_at datetime2(3) NOT NULL CONSTRAINT DF_account_point_updated DEFAULT SYSUTCDATETIME())`,

  `IF OBJECT_ID('dbo.point_ledger') IS NULL CREATE TABLE dbo.point_ledger (
     id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_point_ledger PRIMARY KEY,
     account_id int NOT NULL,
     delta bigint NOT NULL,
     balance_after bigint NOT NULL,
     kind varchar(16) NOT NULL CONSTRAINT CK_point_ledger_kind CHECK (kind IN ('topup','deduct','purchase','refund','adjust')),
     order_id bigint NULL,
     operator nvarchar(32) NOT NULL,
     reason nvarchar(200) NOT NULL,
     server_id int NULL,
     created_at datetime2(3) NOT NULL CONSTRAINT DF_point_ledger_created DEFAULT SYSUTCDATETIME())`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_point_ledger_account')
     CREATE INDEX IX_point_ledger_account ON dbo.point_ledger (account_id, id DESC)`,

  `IF OBJECT_ID('dbo.shop_category') IS NULL CREATE TABLE dbo.shop_category (
     category_id int NOT NULL CONSTRAINT PK_shop_category PRIMARY KEY,
     parent_id int NOT NULL CONSTRAINT DF_shop_category_parent DEFAULT 0,
     name nvarchar(50) NOT NULL,
     display_order smallint NOT NULL CONSTRAINT DF_shop_category_order DEFAULT 0,
     enabled bit NOT NULL CONSTRAINT DF_shop_category_enabled DEFAULT 1,
     updated_at datetime2(3) NOT NULL CONSTRAINT DF_shop_category_updated DEFAULT SYSUTCDATETIME())`,

  `IF OBJECT_ID('dbo.shop_goods') IS NULL CREATE TABLE dbo.shop_goods (
     goods_id int NOT NULL CONSTRAINT PK_shop_goods PRIMARY KEY,
     goods_name nvarchar(50) NOT NULL,
     item_name_id int NOT NULL,
     item_amount int NOT NULL CONSTRAINT DF_shop_goods_amount DEFAULT 1 CONSTRAINT CK_shop_goods_amount CHECK (item_amount > 0),
     item_duration_sec int NOT NULL CONSTRAINT DF_shop_goods_duration DEFAULT 0,
     sale_price int NOT NULL CONSTRAINT CK_shop_goods_price CHECK (sale_price >= 0),
     price_category int NOT NULL CONSTRAINT DF_shop_goods_pcat DEFAULT 1,
     price_id int NOT NULL CONSTRAINT DF_shop_goods_pid DEFAULT 1,
     sale_quantity int NOT NULL CONSTRAINT DF_shop_goods_qty DEFAULT 9999,
     sale_status smallint NOT NULL CONSTRAINT DF_shop_goods_status DEFAULT 1,
     item_type_code smallint NOT NULL CONSTRAINT DF_shop_goods_type DEFAULT 0,
     icon_key bigint NOT NULL CONSTRAINT DF_shop_goods_icon DEFAULT 0,
     icon_bitset int NOT NULL CONSTRAINT DF_shop_goods_iconbits DEFAULT 0,
     description nvarchar(200) NOT NULL CONSTRAINT DF_shop_goods_desc DEFAULT N'',
     avail_start bigint NOT NULL CONSTRAINT DF_shop_goods_start DEFAULT 0,
     avail_end bigint NOT NULL CONSTRAINT DF_shop_goods_end DEFAULT 0,
     enabled bit NOT NULL CONSTRAINT DF_shop_goods_enabled DEFAULT 1,
     updated_at datetime2(3) NOT NULL CONSTRAINT DF_shop_goods_updated DEFAULT SYSUTCDATETIME())`,

  `IF OBJECT_ID('dbo.shop_goods_category') IS NULL CREATE TABLE dbo.shop_goods_category (
     goods_id int NOT NULL CONSTRAINT FK_sgc_goods REFERENCES dbo.shop_goods (goods_id),
     category_id int NOT NULL CONSTRAINT FK_sgc_category REFERENCES dbo.shop_category (category_id),
     display_order smallint NOT NULL CONSTRAINT DF_sgc_order DEFAULT 0,
     CONSTRAINT PK_shop_goods_category PRIMARY KEY (goods_id, category_id))`,

  `IF OBJECT_ID('dbo.shop_ranking') IS NULL CREATE TABLE dbo.shop_ranking (
     ranking_type smallint NOT NULL CONSTRAINT DF_shop_ranking_type DEFAULT 1,
     position int NOT NULL,
     goods_id int NOT NULL CONSTRAINT FK_shop_ranking_goods REFERENCES dbo.shop_goods (goods_id),
     CONSTRAINT PK_shop_ranking PRIMARY KEY (ranking_type, position))`,

  `IF OBJECT_ID('dbo.shop_promotion') IS NULL CREATE TABLE dbo.shop_promotion (
     promotion_id int NOT NULL CONSTRAINT PK_shop_promotion PRIMARY KEY,
     goods_id int NOT NULL CONSTRAINT FK_shop_promotion_goods REFERENCES dbo.shop_goods (goods_id),
     avail_start bigint NOT NULL CONSTRAINT DF_shop_promotion_start DEFAULT 0,
     avail_end bigint NOT NULL CONSTRAINT DF_shop_promotion_end DEFAULT 0)`,

  `IF OBJECT_ID('dbo.seq_order') IS NULL CREATE SEQUENCE dbo.seq_order AS bigint START WITH 1000001 INCREMENT BY 1`,

  `IF OBJECT_ID('dbo.shop_order') IS NULL CREATE TABLE dbo.shop_order (
     order_id bigint NOT NULL CONSTRAINT PK_shop_order PRIMARY KEY,
     request_key varchar(64) NULL,
     server_id int NULL,
     status varchar(12) NOT NULL CONSTRAINT CK_shop_order_status CHECK (status IN ('paid','delivered','refunded')),
     buyer_account_id int NOT NULL,
     buyer_char_id int NOT NULL,
     buyer_char_name nvarchar(32) NOT NULL,
     recipient_char_id int NULL,
     recipient_name nvarchar(32) NULL,
     recipient_checked bit NOT NULL CONSTRAINT DF_shop_order_rchecked DEFAULT 0,
     goods_id int NULL,
     goods_name nvarchar(50) NOT NULL,
     item_name_id int NOT NULL,
     item_amount int NOT NULL,
     item_duration_sec int NOT NULL CONSTRAINT DF_shop_order_duration DEFAULT 0,
     unit_count int NOT NULL CONSTRAINT DF_shop_order_units DEFAULT 1,
     price bigint NOT NULL,
     price_category int NOT NULL CONSTRAINT DF_shop_order_pcat DEFAULT 1,
     price_id int NOT NULL CONSTRAINT DF_shop_order_pid DEFAULT 1,
     redelivered int NOT NULL CONSTRAINT DF_shop_order_redelivered DEFAULT 0,
     created_at datetime2(3) NOT NULL CONSTRAINT DF_shop_order_created DEFAULT SYSUTCDATETIME(),
     delivered_at datetime2(3) NULL)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_shop_order_request')
     CREATE UNIQUE INDEX UX_shop_order_request ON dbo.shop_order (request_key) WHERE request_key IS NOT NULL`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_shop_order_status')
     CREATE INDEX IX_shop_order_status ON dbo.shop_order (status, order_id)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_shop_order_buyer')
     CREATE INDEX IX_shop_order_buyer ON dbo.shop_order (buyer_account_id, order_id DESC)`,

  `IF OBJECT_ID('dbo.admin_log') IS NULL CREATE TABLE dbo.admin_log (
     id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_admin_log PRIMARY KEY,
     created_at datetime2(3) NOT NULL CONSTRAINT DF_admin_log_created DEFAULT SYSUTCDATETIME(),
     action varchar(32) NOT NULL,
     target nvarchar(100) NULL,
     detail nvarchar(max) NULL,
     ok bit NOT NULL CONSTRAINT DF_admin_log_ok DEFAULT 1,
     message nvarchar(400) NULL,
     remote_addr varchar(64) NULL)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_admin_log_action')
     CREATE INDEX IX_admin_log_action ON dbo.admin_log (action, id DESC)`,
];

const ms = (d: Date | null | undefined) => (d ? new Date(d).getTime() : undefined);

function rowToOrder(r: any): ShopOrder {
  return {
    warehouseId: Number(r.order_id), status: r.status, t: ms(r.created_at)!, deliveredAt: ms(r.delivered_at), redelivered: r.redelivered,
    accountId: r.buyer_account_id, charId: r.buyer_char_id, charName: r.buyer_char_name, itemNameId: r.item_name_id,
    itemAmount: r.item_amount, durationSec: r.item_duration_sec, price: Number(r.price), goodsName: r.goods_name, goodsId: r.goods_id,
    recipientCharId: r.recipient_char_id ?? undefined, recipientName: r.recipient_name ?? undefined, recipientChecked: !!r.recipient_checked,
  };
}

export class ShopDb {
  private cfg: Config;
  readonly dbName: string;
  constructor(cfg: Config, dbName = SHOP_DB) { this.cfg = cfg; this.dbName = dbName; }
  private pool() { return poolFor(this.cfg, this.dbName); }

  // Create the database (via master) and the schema. Safe to call on every start.
  async ensure(): Promise<string[]> {
    const notes: string[] = [];
    const master = await poolFor(this.cfg, 'master');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.dbName)) throw new Error('bad database name');
    const exists = await master.request().input('n', sql.NVarChar, this.dbName).query(`SELECT DB_ID(@n) AS id`);
    if (exists.recordset[0].id == null) {
      // Same collation as the game databases (Chinese_PRC_CI_AS) so names compare the same way.
      await master.request().batch(`CREATE DATABASE [${this.dbName}] COLLATE Chinese_PRC_CI_AS`);
      notes.push(`已创建数据库 ${this.dbName}`);
    }
    const p = await this.pool();
    for (const b of SCHEMA) await p.request().batch(b);
    await p.request().input('v', sql.NVarChar, SCHEMA_VERSION).query(
      `MERGE dbo.schema_meta AS t USING (SELECT N'schema_version' AS k) AS s ON t.k = s.k
       WHEN MATCHED THEN UPDATE SET v = @v, updated_at = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN INSERT (k, v) VALUES (N'schema_version', @v);`);
    return notes;
  }

  async meta(k: string): Promise<string | null> {
    const r = await (await this.pool()).request().input('k', sql.NVarChar, k).query(`SELECT v FROM dbo.schema_meta WHERE k = @k`);
    return r.recordset[0]?.v ?? null;
  }

  // ---------- points ----------

  async balance(accountId: number): Promise<number> {
    const r = await (await this.pool()).request().input('a', sql.Int, accountId).query(`SELECT balance FROM dbo.account_point WHERE account_id = @a`);
    return Number(r.recordset[0]?.balance ?? 0);
  }

  async allBalances(): Promise<Record<string, number>> {
    const r = await (await this.pool()).request().query(`SELECT account_id, balance FROM dbo.account_point`);
    return Object.fromEntries(r.recordset.map((x: any) => [String(x.account_id), Number(x.balance)]));
  }

  // Atomic: lock the row, refuse to go negative, update, append to the ledger.
  async changePoints(accountId: number, delta: number, kind: 'topup' | 'deduct' | 'refund' | 'adjust', operator: string,
    reason: string, accountName: string | null = null): Promise<{ ok: boolean; balance: number }> {
    const r = await (await this.pool()).request()
      .input('a', sql.Int, accountId).input('d', sql.BigInt, delta).input('k', sql.VarChar(16), kind)
      .input('op', sql.NVarChar(32), operator).input('rs', sql.NVarChar(200), reason).input('n', sql.NVarChar(32), accountName)
      .query(`SET XACT_ABORT ON; BEGIN TRAN;
        IF NOT EXISTS (SELECT 1 FROM dbo.account_point WITH (UPDLOCK, HOLDLOCK) WHERE account_id = @a)
          INSERT dbo.account_point (account_id, account_name, balance) VALUES (@a, @n, 0);
        DECLARE @bal bigint = (SELECT balance FROM dbo.account_point WITH (UPDLOCK) WHERE account_id = @a);
        IF @bal + @d < 0 BEGIN ROLLBACK; SELECT CAST(0 AS bit) AS ok, @bal AS balance; RETURN; END
        UPDATE dbo.account_point SET balance = @bal + @d, account_name = COALESCE(@n, account_name), updated_at = SYSUTCDATETIME() WHERE account_id = @a;
        INSERT dbo.point_ledger (account_id, delta, balance_after, kind, operator, reason) VALUES (@a, @d, @bal + @d, @k, @op, @rs);
        COMMIT; SELECT CAST(1 AS bit) AS ok, @bal + @d AS balance;`);
    const row = r.recordset[0];
    return { ok: !!row.ok, balance: Number(row.balance) };
  }

  async history(accountId?: number, limit = 200): Promise<PointEntry[]> {
    const req = (await this.pool()).request().input('lim', sql.Int, limit);
    if (accountId !== undefined) req.input('a', sql.Int, accountId);
    const r = await req.query(`SELECT TOP (@lim) * FROM dbo.point_ledger ${accountId !== undefined ? 'WHERE account_id = @a' : ''} ORDER BY id DESC`);
    return r.recordset.map((x: any) => ({ t: ms(x.created_at)!, accountId: x.account_id, delta: Number(x.delta), balance: Number(x.balance_after),
      reason: x.reason, kind: x.kind, operator: x.operator, orderId: x.order_id == null ? null : Number(x.order_id) }));
  }

  // ---------- orders ----------

  // One transaction: dedupe on the request key, check and deduct the balance, create the order, write the ledger.
  async buy(b: BuyRequest): Promise<{ result: 'ok' | 'nocash' | 'dup'; orderId: number | null; balance: number }> {
    const r = await (await this.pool()).request()
      .input('rk', sql.VarChar(64), b.requestKey).input('sid', sql.Int, b.serverId).input('a', sql.Int, b.accountId)
      .input('c', sql.Int, b.charId).input('cn', sql.NVarChar(32), b.charName).input('nid', sql.Int, b.itemNameId)
      .input('amt', sql.Int, b.itemAmount).input('dur', sql.Int, b.durationSec).input('p', sql.BigInt, b.price)
      .input('pc', sql.Int, b.priceCategory).input('pi', sql.Int, b.priceId).input('gid', sql.Int, b.goodsId)
      .input('gn', sql.NVarChar(50), b.goodsName)
      .query(`SET XACT_ABORT ON; BEGIN TRAN;
        DECLARE @dup bigint = (SELECT order_id FROM dbo.shop_order WITH (UPDLOCK, HOLDLOCK) WHERE request_key = @rk);
        IF @dup IS NOT NULL BEGIN COMMIT; SELECT 'dup' AS result, @dup AS order_id, ISNULL((SELECT balance FROM dbo.account_point WHERE account_id = @a), 0) AS balance; RETURN; END
        DECLARE @bal bigint = ISNULL((SELECT balance FROM dbo.account_point WITH (UPDLOCK, HOLDLOCK) WHERE account_id = @a), 0);
        IF @bal < @p BEGIN ROLLBACK; SELECT 'nocash' AS result, CAST(NULL AS bigint) AS order_id, @bal AS balance; RETURN; END
        DECLARE @oid bigint = NEXT VALUE FOR dbo.seq_order;
        IF @p > 0 UPDATE dbo.account_point SET balance = @bal - @p, updated_at = SYSUTCDATETIME() WHERE account_id = @a;
        INSERT dbo.shop_order (order_id, request_key, server_id, status, buyer_account_id, buyer_char_id, buyer_char_name, goods_id,
          goods_name, item_name_id, item_amount, item_duration_sec, price, price_category, price_id)
        VALUES (@oid, @rk, @sid, 'paid', @a, @c, @cn, @gid, @gn, @nid, @amt, @dur, @p, @pc, @pi);
        IF @p > 0 INSERT dbo.point_ledger (account_id, delta, balance_after, kind, order_id, operator, reason, server_id)
          VALUES (@a, -@p, @bal - @p, 'purchase', @oid, N'game', N'购买 ' + @gn + N'（订单 ' + CAST(@oid AS nvarchar(20)) + N'）', @sid);
        COMMIT; SELECT 'ok' AS result, @oid AS order_id, @bal - @p AS balance;`);
    const row = r.recordset[0];
    return { result: row.result, orderId: row.order_id == null ? null : Number(row.order_id), balance: Number(row.balance) };
  }

  // Marks the given orders delivered; returns the orders that exist (already-delivered ones included).
  async markDelivered(ids: number[]): Promise<ShopOrder[]> {
    if (!ids.length) return [];
    const p = await this.pool();
    const tvp = ids.map((x) => String(Math.trunc(x))).join(',');
    await p.request().input('ids', sql.VarChar(sql.MAX), tvp).query(
      `UPDATE dbo.shop_order SET status = 'delivered', delivered_at = SYSUTCDATETIME()
       WHERE status = 'paid' AND order_id IN (SELECT CAST(value AS bigint) FROM STRING_SPLIT(@ids, ','))`);
    const r = await p.request().input('ids', sql.VarChar(sql.MAX), tvp).query(
      `SELECT * FROM dbo.shop_order WHERE order_id IN (SELECT CAST(value AS bigint) FROM STRING_SPLIT(@ids, ','))`);
    return r.recordset.map(rowToOrder);
  }

  async pendingOrders(): Promise<ShopOrder[]> {
    const r = await (await this.pool()).request().query(`SELECT * FROM dbo.shop_order WHERE status = 'paid' ORDER BY order_id`);
    return r.recordset.map(rowToOrder);
  }

  async bumpRedelivered(ids: number[]): Promise<void> {
    if (!ids.length) return;
    await (await this.pool()).request().input('ids', sql.VarChar(sql.MAX), ids.join(',')).query(
      `UPDATE dbo.shop_order SET redelivered = redelivered + 1 WHERE order_id IN (SELECT CAST(value AS bigint) FROM STRING_SPLIT(@ids, ','))`);
  }

  async setRecipient(orderId: number, charId: number | null, name: string | null): Promise<void> {
    await (await this.pool()).request().input('o', sql.BigInt, orderId).input('c', sql.Int, charId).input('n', sql.NVarChar(32), name).query(
      `UPDATE dbo.shop_order SET recipient_checked = 1, recipient_char_id = @c, recipient_name = @n WHERE order_id = @o`);
  }

  async ordersNeedingRecipient(): Promise<ShopOrder[]> {
    const r = await (await this.pool()).request().query(`SELECT * FROM dbo.shop_order WHERE status = 'delivered' AND recipient_checked = 0`);
    return r.recordset.map(rowToOrder);
  }

  async listOrders(limit = 200): Promise<ShopOrder[]> {
    const r = await (await this.pool()).request().input('lim', sql.Int, limit).query(`SELECT TOP (@lim) * FROM dbo.shop_order ORDER BY order_id DESC`);
    return r.recordset.map(rowToOrder);
  }

  // ---------- catalog ----------

  async loadCatalog(): Promise<ShopCatalog> {
    const p = await this.pool();
    const [cats, goods, gc, rank, promo] = await Promise.all([
      p.request().query(`SELECT * FROM dbo.shop_category ORDER BY display_order, category_id`),
      p.request().query(`SELECT * FROM dbo.shop_goods ORDER BY goods_id`),
      p.request().query(`SELECT * FROM dbo.shop_goods_category ORDER BY goods_id, display_order`),
      p.request().query(`SELECT * FROM dbo.shop_ranking ORDER BY ranking_type, position`),
      p.request().query(`SELECT * FROM dbo.shop_promotion ORDER BY promotion_id`),
    ]);
    const byGoods = new Map<number, Array<{ categoryId: number; displayOrder: number }>>();
    for (const x of gc.recordset) {
      if (!byGoods.has(x.goods_id)) byGoods.set(x.goods_id, []);
      byGoods.get(x.goods_id)!.push({ categoryId: x.category_id, displayOrder: x.display_order });
    }
    return {
      categories: cats.recordset.map((x: any) => ({ categoryId: x.category_id, parentId: x.parent_id, categoryName: x.name, displayOrder: x.display_order, enabled: !!x.enabled })),
      goods: goods.recordset.map((x: any): ShopGoods => ({
        goodsId: x.goods_id, goodsName: x.goods_name, salePrice: x.sale_price, priceCategory: x.price_category, priceId: x.price_id,
        saleEnableQuantity: x.sale_quantity, saleStatusCode: x.sale_status, itemTypeCode: x.item_type_code, gameItemKey: x.item_name_id,
        desc: x.description, goodsIconKey: Number(x.icon_key), goodsIconBitSet: x.icon_bitset, itemDuration: x.item_duration_sec,
        itemAmount: x.item_amount, availStart: Number(x.avail_start), availEnd: Number(x.avail_end), enabled: !!x.enabled,
        categories: byGoods.get(x.goods_id) ?? [],
      })),
      rankings: rank.recordset.map((x: any) => ({ rankingTypeCode: x.ranking_type, ranking: x.position, goodsId: x.goods_id })),
      promotions: promo.recordset.map((x: any) => ({ promotionId: x.promotion_id, goodsId: x.goods_id, availStart: Number(x.avail_start), availEnd: Number(x.avail_end) })),
    };
  }

  // Replaces the whole catalog in one transaction; any bad reference (unknown category/goods) rolls everything back.
  async saveCatalog(c: ShopCatalog): Promise<void> {
    const tx = new sql.Transaction(await this.pool());
    await tx.begin();
    try {
      await this.writeCatalog(tx, c);
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }
  }

  private async writeCatalog(tx: sql.Transaction, c: ShopCatalog): Promise<void> {
    {
      const q = () => new sql.Request(tx);
      await q().batch(`DELETE dbo.shop_goods_category; DELETE dbo.shop_ranking; DELETE dbo.shop_promotion; DELETE dbo.shop_goods; DELETE dbo.shop_category;`);
      for (const x of c.categories) {
        await q().input('id', sql.Int, x.categoryId).input('pid', sql.Int, x.parentId ?? 0).input('n', sql.NVarChar(50), x.categoryName)
          .input('o', sql.SmallInt, x.displayOrder ?? 0).input('e', sql.Bit, x.enabled !== false)
          .query(`INSERT dbo.shop_category (category_id, parent_id, name, display_order, enabled) VALUES (@id, @pid, @n, @o, @e)`);
      }
      for (const g of c.goods) {
        await q().input('id', sql.Int, g.goodsId).input('n', sql.NVarChar(50), g.goodsName).input('nid', sql.Int, g.gameItemKey)
          .input('amt', sql.Int, g.itemAmount ?? 1).input('dur', sql.Int, g.itemDuration ?? 0).input('pr', sql.Int, g.salePrice)
          .input('pc', sql.Int, g.priceCategory ?? 1).input('pi', sql.Int, g.priceId ?? 1).input('qty', sql.Int, g.saleEnableQuantity ?? 9999)
          .input('st', sql.SmallInt, g.saleStatusCode ?? 1).input('tc', sql.SmallInt, g.itemTypeCode ?? 0)
          .input('ik', sql.BigInt, g.goodsIconKey ?? 0).input('ib', sql.Int, g.goodsIconBitSet ?? 0).input('d', sql.NVarChar(200), g.desc ?? '')
          .input('as', sql.BigInt, g.availStart ?? 0).input('ae', sql.BigInt, g.availEnd ?? 0).input('e', sql.Bit, g.enabled !== false)
          .query(`INSERT dbo.shop_goods (goods_id, goods_name, item_name_id, item_amount, item_duration_sec, sale_price, price_category, price_id,
                    sale_quantity, sale_status, item_type_code, icon_key, icon_bitset, description, avail_start, avail_end, enabled)
                  VALUES (@id, @n, @nid, @amt, @dur, @pr, @pc, @pi, @qty, @st, @tc, @ik, @ib, @d, @as, @ae, @e)`);
        for (const gc of g.categories ?? []) {
          await q().input('g', sql.Int, g.goodsId).input('c', sql.Int, gc.categoryId).input('o', sql.SmallInt, gc.displayOrder ?? 0)
            .query(`INSERT dbo.shop_goods_category (goods_id, category_id, display_order) VALUES (@g, @c, @o)`);
        }
      }
      for (const r of c.rankings ?? []) {
        await q().input('t', sql.SmallInt, r.rankingTypeCode ?? 1).input('pos', sql.Int, r.ranking).input('g', sql.Int, r.goodsId)
          .query(`INSERT dbo.shop_ranking (ranking_type, position, goods_id) VALUES (@t, @pos, @g)`);
      }
      for (const r of c.promotions ?? []) {
        await q().input('id', sql.Int, r.promotionId).input('g', sql.Int, r.goodsId).input('as', sql.BigInt, r.availStart ?? 0).input('ae', sql.BigInt, r.availEnd ?? 0)
          .query(`INSERT dbo.shop_promotion (promotion_id, goods_id, avail_start, avail_end) VALUES (@id, @g, @as, @ae)`);
      }
    }
  }

  // ---------- admin log ----------

  async adminLog(e: AdminLogEntry): Promise<void> {
    await (await this.pool()).request().input('a', sql.VarChar(32), e.action).input('t', sql.NVarChar(100), e.target ?? null)
      .input('d', sql.NVarChar(sql.MAX), e.detail === undefined ? null : JSON.stringify(e.detail)).input('ok', sql.Bit, e.ok !== false)
      .input('m', sql.NVarChar(400), e.message ? String(e.message).slice(0, 400) : null).input('ip', sql.VarChar(64), e.remoteAddr ?? null)
      .query(`INSERT dbo.admin_log (action, target, detail, ok, message, remote_addr) VALUES (@a, @t, @d, @ok, @m, @ip)`);
  }

  async listAdminLog(limit = 200, action?: string): Promise<any[]> {
    const req = (await this.pool()).request().input('lim', sql.Int, limit);
    if (action) req.input('a', sql.VarChar(32), action);
    const r = await req.query(`SELECT TOP (@lim) * FROM dbo.admin_log ${action ? 'WHERE action = @a' : ''} ORDER BY id DESC`);
    return r.recordset.map((x: any) => ({ id: Number(x.id), t: ms(x.created_at), action: x.action, target: x.target,
      detail: x.detail ? JSON.parse(x.detail) : null, ok: !!x.ok, message: x.message, remoteAddr: x.remote_addr }));
  }

  // ---------- one-time import of the old JSON files ----------

  // Imports data/shop.json, points.json, points_log.jsonl and shop_orders.json once (marker in schema_meta),
  // then checks the imported balances against points.json. The JSON files are left untouched as a backup.
  async importJson(dataDir: string): Promise<string[]> {
    if (await this.meta('json_import')) return [];
    const notes: string[] = [];
    const f = (n: string) => path.join(dataDir, n);
    const p = await this.pool();
    const counts = await p.request().query(`SELECT (SELECT COUNT(*) FROM dbo.account_point) a, (SELECT COUNT(*) FROM dbo.shop_order) o, (SELECT COUNT(*) FROM dbo.shop_goods) g, (SELECT COUNT(*) FROM dbo.point_ledger) l`);
    const c0 = counts.recordset[0];
    if (c0.a || c0.o || c0.g || c0.l) throw new LError('AionShop 里已经有数据但没有导入标记，为避免重复导入已停止，请人工检查', 'AionShop already has data but no import marker; stopped to avoid importing twice, please check by hand');

    const tx = new sql.Transaction(p);
    await tx.begin();
    try {
      const q = () => new sql.Request(tx);
      if (fs.existsSync(f('shop.json'))) {
        const cat = JSON.parse(fs.readFileSync(f('shop.json'), 'utf8')) as ShopCatalog;
        await this.writeCatalog(tx, cat);
        notes.push(`商品目录：分类 ${cat.categories.length}、商品 ${cat.goods.length}、排行 ${(cat.rankings ?? []).length}`);
      }
      const balances: Record<string, number> = fs.existsSync(f('points.json')) ? JSON.parse(fs.readFileSync(f('points.json'), 'utf8')) : {};
      for (const [acc, bal] of Object.entries(balances)) {
        await q().input('a', sql.Int, Number(acc)).input('b', sql.BigInt, bal).query(`INSERT dbo.account_point (account_id, balance) VALUES (@a, @b)`);
      }
      let ledgerN = 0;
      if (fs.existsSync(f('points_log.jsonl'))) {
        for (const line of fs.readFileSync(f('points_log.jsonl'), 'utf8').split('\n').filter(Boolean)) {
          const e = JSON.parse(line);
          const m = /订单 (\d+)/.exec(e.reason ?? '');
          const kind = String(e.reason ?? '').startsWith('购买') ? 'purchase' : e.delta > 0 ? 'topup' : 'deduct';
          await q().input('a', sql.Int, e.accountId).input('d', sql.BigInt, e.delta).input('b', sql.BigInt, e.balance)
            .input('k', sql.VarChar(16), kind).input('o', sql.BigInt, m ? Number(m[1]) : null)
            .input('op', sql.NVarChar(32), kind === 'purchase' ? 'game' : 'admin').input('r', sql.NVarChar(200), e.reason ?? '')
            .input('t', sql.DateTime2, new Date(e.t))
            .query(`INSERT dbo.point_ledger (account_id, delta, balance_after, kind, order_id, operator, reason, created_at) VALUES (@a, @d, @b, @k, @o, @op, @r, @t)`);
          ledgerN++;
        }
      }
      let maxOrder = 0, orderN = 0;
      if (fs.existsSync(f('shop_orders.json'))) {
        for (const o of JSON.parse(fs.readFileSync(f('shop_orders.json'), 'utf8')) as any[]) {
          await q().input('id', sql.BigInt, o.warehouseId).input('st', sql.VarChar(12), o.status).input('a', sql.Int, o.accountId)
            .input('c', sql.Int, o.charId).input('cn', sql.NVarChar(32), o.charName).input('rc', sql.Int, o.recipientCharId ?? null)
            .input('rn', sql.NVarChar(32), o.recipientName ?? null).input('rk', sql.Bit, !!o.recipientChecked).input('gn', sql.NVarChar(50), o.goodsName)
            .input('nid', sql.Int, o.itemNameId).input('amt', sql.Int, o.itemAmount).input('dur', sql.Int, o.durationSec ?? 0)
            .input('p', sql.BigInt, o.price).input('rd', sql.Int, o.redelivered ?? 0).input('t', sql.DateTime2, new Date(o.t))
            .input('dt', sql.DateTime2, o.deliveredAt ? new Date(o.deliveredAt) : null)
            .query(`INSERT dbo.shop_order (order_id, server_id, status, buyer_account_id, buyer_char_id, buyer_char_name, recipient_char_id, recipient_name,
                      recipient_checked, goods_name, item_name_id, item_amount, item_duration_sec, price, redelivered, created_at, delivered_at)
                    VALUES (@id, 1, @st, @a, @c, @cn, @rc, @rn, @rk, @gn, @nid, @amt, @dur, @p, @rd, @t, @dt)`);
          maxOrder = Math.max(maxOrder, o.warehouseId); orderN++;
        }
      }
      if (maxOrder) await q().batch(`ALTER SEQUENCE dbo.seq_order RESTART WITH ${maxOrder + 1}`);
      // verify: every balance equals points.json and the last ledger entry of each account
      const chk = await q().query(`SELECT a.account_id, a.balance,
          (SELECT TOP 1 balance_after FROM dbo.point_ledger l WHERE l.account_id = a.account_id ORDER BY l.created_at DESC, l.id DESC) AS last_ledger
        FROM dbo.account_point a`);
      for (const r of chk.recordset) {
        if (Number(r.balance) !== balances[String(r.account_id)]) throw new LError(`账号 ${r.account_id} 余额导入不一致`, `Account ${r.account_id}: imported balance does not match`);
        if (r.last_ledger != null && Number(r.last_ledger) !== Number(r.balance)) throw new LError(`账号 ${r.account_id} 余额 ${r.balance} 与流水最后一条 ${r.last_ledger} 不一致`, `Account ${r.account_id}: balance ${r.balance} does not match the last ledger entry ${r.last_ledger}`);
      }
      await q().input('v', sql.NVarChar(400), new Date().toISOString()).query(`INSERT dbo.schema_meta (k, v) VALUES (N'json_import', @v)`);
      await tx.commit();
      notes.push(`点券：账号 ${Object.keys(balances).length}、流水 ${ledgerN}；订单 ${orderN}（下一个订单号 ${Math.max(maxOrder + 1, 1000001)}）；余额已核对`);
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }
    return notes;
  }
}
