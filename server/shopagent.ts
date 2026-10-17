// "Shop agent" for the in-game cash shop: account cash points, buy / gift and item delivery, hosted in the
// admin process. Server64 (ShopAgentClient / ShopAgentSocket) connects to MainServer/common.xml
// <shopAgentServerAddr>:<shopAgentServerPort>; it stands in for NCsoft's ShopAgentServer + its billing backend.
// Wire format (reversed from Server64.pdb: ShopAgentSocket::OnRead, g_shopAgentPacketTable, CPacket::OnIOCallback,
// ServerToShopAgent::Encode*, ShopAgentToServer::Decode*, ShopAgentClient::On*):
//   both directions: u16 total len (incl. this header) | u16 type | payload   (agent -> server: type < 0x1c, len <= 0x2001)
//   Server64 -> agent:
//     0x00 ProtocolVersion  u32 1 | u32 0x1b | u32 serverId                         (sent on connect)
//     0x14 GetItemsForServer u32 txid                                               (sent after our 0x00 reply)
//     0x1a GetPoint         u32 txid | u32 accountId | u32 n | n x (u16 cat=5, u16 id=0)   (on every account login)
//     0x0c BuyItem          u32 txid | u32 buyerAccountId | u32 buyerCharId | u32 itemNameId | u32 itemAmount |
//                           u32 n(=1) | n x (u16 priceCategory | u16 priceId | i64 price) | wstr buyerName
//                           (ShopAgentClient::RequestBuy; fields come from ShopDB::_MakeShopAgentItem: nameId =
//                           goods.gameItemKey, itemAmount = goods.itemAmount, price = goods.salePrice per unit.
//                           The unit count the player asked for is NOT sent, but delivery repeats it)
//     0x17 DeleteItem       u32 txid | u32 n | n x u64 warehouseId   = "delivered": sent after the cash-item mail
//                           (RQ_SA_MAIL_WRITE -> CacheD WriteMailByIB -> aion_MailWriteSys) has been written
//   agent -> Server64:
//     0x00 ConnectAck       u32 protocolVersion (only logged)
//     0x14 GetItemsAck      u32 txid | u32 result | u16 | u16 | u32 n | n x item record; Server64 mails every record
//                           to its recipient (redelivery after a crash/restart). Record (OnGetItemForServerAck):
//                           u64 warehouseId | u32 nameId | u32 unitCount(1..50) | u8 extLen=4 | i16 itemAmount(>0) |
//                           i16 durationHours | u32 buyerAccount | u32 buyerServerId | u32 buyerChar | wstr buyerName |
//                           u32 recipientAccount | u32 recipientChar | wstr recipientName
//     0x1a GetPointAck      u32 txid | u32 result | u32 n | n x (u16 cat | u16 id | u64 amount)
//                           -> Socket::SetCashPoint for the account; the client reads it when it opens the shop (bit 0x10)
//     0x1b PointChangeNoti  u32 accountId | u16 cat | u16 id | i64 delta | u64 newAmount
//                           -> SetCashPoint + SendCashPoint: the balance updates live in an open shop window
//     0x0c BuyItemAck       u32 txid | u32 result (| u64 warehouseId if result = 0); result 2 -> shop error 0x67,
//                           5/6 -> 0x66, other non-zero -> 0x64. On success Server64 stores the item under that
//                           warehouseId, mails it (ProcessCharacterItem) and re-queries the balance.
//     0x17/0x18/0x19 are no-ops in Server64.
// Storage is the AionShop database (shopdb.ts): balances + ledger, and one shop_order per BuyItem ('paid' until
// Server64 confirms delivery with DeleteItem, then 'delivered'). Paid-but-undelivered orders are handed back on every
// GetItemsForServer. A buy is one DB transaction keyed on a unique request key, so it can't be charged twice.
import net from 'node:net';
import type { ShopDb, ShopOrder } from './shopdb.ts';
import { L, LError, pick, type Lang, type Msg } from './i18n.ts';

const T = { VERSION: 0x00, BUY: 0x0c, GET_ITEMS: 0x14, DELETE_ITEMS: 0x17, GET_POINT: 0x1a, POINT_CHANGE: 0x1b };
const PROTOCOL_VERSION = 0x1b;
export const POINT_CAT = 5, POINT_ID = 0;   // the only (category, id) pair Server64 asks for
const BUY_NOT_ENOUGH_CASH = 2;            // -> ShopResult 0x67
const BUY_FAILED = 1;                     // -> ShopResult 0x64 (generic)
const MAX_PACKET = 0x1f00;

function packet(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.alloc(4);
  h.writeUInt16LE(4 + payload.length, 0);
  h.writeUInt16LE(type, 2);
  return Buffer.concat([h, payload]);
}

export type AgentLog = { seq: number; t: number; text: Msg };
// After Server64 confirms delivery: who actually got the cash-item mail (the BuyItem packet has no recipient).
export type MailLookup = (o: ShopOrder) => Promise<{ charId: number; name: string } | null>;
// Looks up catalog info for an item the server is buying (the BuyItem packet carries only nameId/amount/price).
export type GoodsLookup = (itemNameId: number, price: number) => Promise<{ goodsId: number; goodsName: string; itemDuration: number } | null>;

function wstr(d: Buffer, off: number): { s: string; next: number } {
  let e = off;
  while (e + 1 < d.length && (d[e] | d[e + 1]) !== 0) e += 2;
  return { s: d.subarray(off, e).toString('utf16le'), next: e + 2 };
}
const wz = (s: string) => Buffer.from((s ?? '') + '\0', 'utf16le');

export class ShopAgentServer {
  host: string; port: number;
  private db: ShopDb;
  private server: net.Server | null = null;
  private conns = new Set<net.Socket>();
  private connSeq = 0;
  private readonly bootId = Date.now().toString(36);   // makes request keys unique across admin restarts
  private logs: AgentLog[] = [];
  private logSeq = 0;
  private lookup: GoodsLookup;
  mailLookup: MailLookup | null = null;
  lastError: Msg | null = null;
  serverId: number | null = null;

  constructor(host: string, port: number, db: ShopDb, lookup: GoodsLookup = async () => null) {
    this.host = host; this.port = port; this.db = db; this.lookup = lookup;
  }

  get running() { return !!this.server?.listening; }
  get connections() { return this.conns.size; }

  log(text: Msg) {
    this.logs.push({ seq: ++this.logSeq, t: Date.now(), text });
    if (this.logs.length > 500) this.logs.shift();
  }
  logsSince(since: number, lang: Lang = 'zh') { return this.logs.filter((l) => l.seq > since).map((l) => ({ ...l, text: pick(l.text, lang) })); }

  // ---------- points ----------

  // Add (or with a negative delta, take) points from the admin. Committed first, then pushed to Server64 so an
  // online player sees it immediately; an offline account picks it up on its next login (GetPoint).
  async change(accountId: number, delta: number, reason: string, accountName: string | null = null): Promise<{ balance: number; pushed: number }> {
    if (!Number.isInteger(accountId) || accountId <= 0) throw new LError('账号编号不对', 'Invalid account id');
    if (!Number.isSafeInteger(delta) || delta === 0) throw new LError('点数必须是非零整数', 'Points must be a non-zero integer');
    const r = await this.db.changePoints(accountId, delta, delta > 0 ? 'topup' : 'deduct', 'admin', reason, accountName);
    if (!r.ok) throw new LError(`余额不足：当前 ${r.balance}`, `Not enough points: balance is ${r.balance}`);
    const pushed = this.pushBalance(accountId, delta, r.balance);
    const d = `${delta > 0 ? '+' : ''}${delta}`;
    this.log(L(`账号 ${accountId} 点券 ${d} → ${r.balance}（${reason}）${pushed ? '，已推送到游戏' : '，主服务器未连接，下次登录生效'}`,
      `Account ${accountId} points ${d} → ${r.balance} (${reason})${pushed ? ', pushed to the game' : '; main server not connected, applies at next login'}`));
    return { balance: r.balance, pushed };
  }

  // ---------- orders ----------

  private async onBuy(s: net.Socket, connKey: string, d: Buffer) {
    const txid = d.readUInt32LE(0), accountId = d.readUInt32LE(4), charId = d.readUInt32LE(8);
    const itemNameId = d.readUInt32LE(12), itemAmount = d.readUInt32LE(16), n = d.readUInt32LE(20);
    let price = 0, priceCategory = 1, priceId = 1, off = 24;
    for (let i = 0; i < n && off + 12 <= d.length; i++, off += 12) {
      if (i === 0) { priceCategory = d.readUInt16LE(off); priceId = d.readUInt16LE(off + 2); }
      price += Number(d.readBigInt64LE(off + 4));
    }
    const charName = wstr(d, off).s;
    const reply = (result: number, warehouseId = 0) => {
      const b = Buffer.alloc(result === 0 ? 16 : 8);
      b.writeUInt32LE(txid, 0); b.writeUInt32LE(result, 4);
      if (result === 0) b.writeBigUInt64LE(BigInt(warehouseId), 8);
      s.write(packet(T.BUY, b));
    };
    const info = await this.lookup(itemNameId, price).catch(() => null);
    const goodsName = info?.goodsName ?? `#${itemNameId}`;
    const who = `${charName || '?'} (#${accountId})`;
    if (!Number.isSafeInteger(price) || price < 0 || itemAmount < 1 || n < 1) {
      reply(BUY_FAILED);
      this.log(L(`购买请求数据异常：${who} ${goodsName} 价格 ${price} 数量 ${itemAmount}，已拒绝`, `Malformed buy request: ${who} ${goodsName} price ${price} amount ${itemAmount}, refused`));
      return;
    }
    let r;
    try {
      r = await this.db.buy({ requestKey: `${connKey}:${txid}`, serverId: this.serverId ?? 1, accountId, charId, charName,
        itemNameId, itemAmount, durationSec: info?.itemDuration ?? 0, price, priceCategory, priceId,
        goodsId: info?.goodsId ?? null, goodsName });
    } catch (e: any) {
      reply(BUY_FAILED);
      this.log(L(`${who} 购买 ${goodsName}：数据库出错，已回复失败（${e.message}）`, `${who} buying ${goodsName}: database error, answered failure (${e.message})`));
      return;
    }
    if (r.result === 'nocash') {
      reply(BUY_NOT_ENOUGH_CASH);
      this.log(L(`${who} 购买 ${goodsName}：点券不足（需要 ${price}，持有 ${r.balance}）`, `${who} buying ${goodsName}: not enough points (needs ${price}, has ${r.balance})`));
      return;
    }
    if (r.result === 'dup') {
      reply(0, r.orderId!);
      this.log(L(`${who} 的购买请求重复（交易号 ${txid}），按原订单 ${r.orderId} 回复，未重复扣点券`, `${who}: duplicate buy request (tx ${txid}), answered with order ${r.orderId}, not charged again`));
      return;
    }
    if (price > 0) this.pushBalance(accountId, -price, r.balance);
    reply(0, r.orderId!);
    this.log(L(`${who} 购买 ${goodsName} ×${itemAmount}，扣 ${price} 点券（余额 ${r.balance}），订单 ${r.orderId}，等待主服务器发邮件`,
      `${who} bought ${goodsName} ×${itemAmount} for ${price} points (balance ${r.balance}), order ${r.orderId}, waiting for the main server to mail it`));
  }

  private async onDelivered(d: Buffer) {
    const n = Math.min(d.readUInt32LE(4), Math.floor((d.length - 8) / 8));
    const ids = Array.from({ length: n }, (_, i) => Number(d.readBigUInt64LE(8 + i * 8)));
    const found = await this.db.markDelivered(ids);
    for (const id of ids) if (!found.some((o) => o.warehouseId === id)) this.log(L(`主服务器确认交付了未知订单 ${id}，忽略`, `Main server confirmed delivery of unknown order ${id}, ignored`));
    for (const o of found) this.annotateRecipient(o);
  }

  // Gifts arrive as an ordinary BuyItem; find the mail CacheD wrote to learn the real recipient.
  // Orders delivered before the recipient lookup existed (or while it failed): look them up once.
  async backfillRecipients() {
    if (!this.mailLookup) return;
    for (const o of await this.db.ordersNeedingRecipient()) {
      const r = await this.mailLookup(o).catch(() => null);
      if (!r) continue;
      const gift = r.charId !== o.charId;
      await this.db.setRecipient(o.warehouseId, gift ? r.charId : null, gift ? r.name : null);
      if (gift) this.log(L(`补查订单 ${o.warehouseId}：${o.charName} 赠送给 ${r.name}`, `Order ${o.warehouseId} looked up: ${o.charName} gifted it to ${r.name}`));
    }
  }

  private annotateRecipient(o: ShopOrder) {
    const done = async (r: { charId: number; name: string } | null) => {
      const gift = !!r && r.charId !== o.charId;
      if (r) await this.db.setRecipient(o.warehouseId, gift ? r.charId : null, gift ? r.name : null).catch(() => {});
      this.log(gift
        ? L(`订单 ${o.warehouseId} 已交付：${o.charName} 赠送的 ${o.goodsName} ×${o.itemAmount} 已发到 ${r!.name} 的邮箱`,
            `Order ${o.warehouseId} delivered: ${o.goodsName} ×${o.itemAmount} gifted by ${o.charName} is in ${r!.name}'s mailbox`)
        : L(`订单 ${o.warehouseId} 已交付：${o.charName} 的邮箱收到 ${o.goodsName} ×${o.itemAmount}`,
            `Order ${o.warehouseId} delivered: ${o.goodsName} ×${o.itemAmount} is in ${o.charName}'s mailbox`));
    };
    if (!this.mailLookup) { void done(null); return; }
    this.mailLookup(o).then(done, (e) => { this.log(L(`查询订单 ${o.warehouseId} 的收件人失败：${e.message}`, `Looking up the recipient of order ${o.warehouseId} failed: ${e.message}`)); void done(null); });
  }

  // GetItemsForServer: hand back every paid-but-undelivered order so Server64 mails it (again).
  private async onGetItems(s: net.Socket, d: Buffer) {
    const txid = d.readUInt32LE(0);
    const recs: Buffer[] = []; const sent: ShopOrder[] = []; let size = 16;
    for (const o of await this.db.pendingOrders()) {
      const fixed = Buffer.alloc(8 + 4 + 4 + 1 + 4 + 12);
      let k = 0;
      fixed.writeBigUInt64LE(BigInt(o.warehouseId), k); k += 8;
      fixed.writeUInt32LE(o.itemNameId, k); k += 4;
      fixed.writeUInt32LE(1, k); k += 4;                                   // unit count
      fixed.writeUInt8(4, k); k += 1;                                      // ext block: amount + duration
      fixed.writeInt16LE(Math.min(o.itemAmount, 0x7fff), k); k += 2;
      fixed.writeInt16LE(Math.min(Math.round(o.durationSec / 3600), 0x7fff), k); k += 2;
      fixed.writeUInt32LE(o.accountId, k); k += 4;
      fixed.writeUInt32LE((this.serverId ?? 1) >>> 0, k); k += 4;
      fixed.writeUInt32LE(o.charId >>> 0, k); k += 4;
      const tail = Buffer.alloc(8); tail.writeUInt32LE(o.accountId, 0); tail.writeUInt32LE(o.charId >>> 0, 4);
      const rec = Buffer.concat([fixed, wz(o.charName), tail, wz(o.charName)]);
      if (size + rec.length > MAX_PACKET) break;                          // the rest goes out on the next connect
      recs.push(rec); sent.push(o); size += rec.length;
    }
    const head = Buffer.alloc(16);
    head.writeUInt32LE(txid, 0); head.writeUInt32LE(recs.length, 12);   // result 0
    s.write(packet(T.GET_ITEMS, Buffer.concat([head, ...recs])));
    if (sent.length) {
      await this.db.bumpRedelivered(sent.map((o) => o.warehouseId));
      const ids = sent.map((o) => o.warehouseId).join(', ');
      this.log(L(`主服务器查询待发物品：补发 ${sent.length} 个未交付订单（${ids}）`, `Main server asked for pending items: resent ${sent.length} undelivered order(s) (${ids})`));
    } else this.log(L('主服务器查询待发物品：无', 'Main server asked for pending items: none'));
  }

  private pushBalance(accountId: number, delta: number, balance: number): number {
    const b = Buffer.alloc(24);
    b.writeUInt32LE(accountId >>> 0, 0);
    b.writeUInt16LE(POINT_CAT, 4);
    b.writeUInt16LE(POINT_ID, 6);
    b.writeBigInt64LE(BigInt(delta), 8);
    b.writeBigUInt64LE(BigInt(balance), 16);
    const p = packet(T.POINT_CHANGE, b);
    for (const s of this.conns) s.write(p);
    return this.conns.size;
  }

  // ---------- server ----------

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const srv = net.createServer((s) => this.onConn(s));
      srv.once('error', (e: NodeJS.ErrnoException) => {
        this.lastError = e.code === 'EADDRINUSE' ? L(`端口 ${this.port} 已被占用`, `Port ${this.port} is already in use`) : e.message;
        this.log(L(`启动失败：${pick(this.lastError, 'zh')}`, `Start failed: ${pick(this.lastError, 'en')}`));
        reject(Object.assign(new Error(pick(this.lastError, 'zh')), { msg: typeof this.lastError === 'string' ? { zh: this.lastError, en: this.lastError } : this.lastError }));
      });
      srv.listen(this.port, this.host, () => {
        this.server = srv; this.lastError = null;
        this.log(L(`点券服务已启动 ${this.host}:${this.port}，等待主服务器连接`, `Points service started on ${this.host}:${this.port}, waiting for the main server`));
        resolve();
      });
    });
  }

  private onConn(s: net.Socket) {
    this.conns.add(s);
    const connKey = `${this.bootId}.${++this.connSeq}`;
    this.log(L(`主服务器已连接 ${s.remoteAddress}:${s.remotePort}`, `Main server connected from ${s.remoteAddress}:${s.remotePort}`));
    let buf = Buffer.alloc(0);
    // DB work is async; chain the packets of one connection so they are handled and answered in arrival order.
    let chain: Promise<void> = Promise.resolve();
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const len = buf.readUInt16LE(0);
        if (len < 4) { this.log(L(`异常包长度 ${len}，断开`, `Bad packet length ${len}, disconnecting`)); s.destroy(); return; }
        if (buf.length < len) break;
        const p = buf.subarray(0, len);
        buf = buf.subarray(len);
        const type = p.readUInt16LE(2), body = Buffer.from(p.subarray(4));
        chain = chain.then(() => this.onPacket(s, connKey, type, body)).catch((e: any) => { this.log(L(`处理出错：${e.message}`, `Handling failed: ${e.message}`)); });
      }
    });
    const bye = (why: Msg) => { if (this.conns.delete(s)) this.log(L(`主服务器连接断开：${pick(why, 'zh')}`, `Main server disconnected: ${pick(why, 'en')}`)); };
    s.on('close', () => bye(L('关闭', 'closed')));
    s.on('error', (e) => bye(e.message));
  }

  private async onPacket(s: net.Socket, connKey: string, type: number, d: Buffer) {
    switch (type) {
      case T.VERSION: {
        this.serverId = d.length >= 12 ? d.readInt32LE(8) : null;
        const pv = d.length >= 8 ? d.readUInt32LE(4) : '?';
        this.log(L(`收到握手（协议 ${pv}，服务器编号 ${this.serverId}），回复握手确认`, `Handshake received (protocol ${pv}, server ${this.serverId}), answered`));
        const b = Buffer.alloc(4); b.writeUInt32LE(PROTOCOL_VERSION, 0);
        s.write(packet(T.VERSION, b));
        break;
      }
      case T.GET_ITEMS:
        await this.onGetItems(s, d);
        break;
      case T.GET_POINT: {
        const txid = d.readUInt32LE(0), accountId = d.readUInt32LE(4), n = Math.min(d.readUInt32LE(8), 16);
        const bal = await this.db.balance(accountId);
        const head = Buffer.alloc(12);
        head.writeUInt32LE(txid, 0); head.writeUInt32LE(n, 8);
        const args: Buffer[] = [];
        for (let i = 0; i < n; i++) {
          const cat = d.readUInt16LE(12 + i * 4), id = d.readUInt16LE(14 + i * 4);
          const a = Buffer.alloc(12);
          a.writeUInt16LE(cat, 0); a.writeUInt16LE(id, 2);
          a.writeBigUInt64LE(BigInt(cat === POINT_CAT && id === POINT_ID ? bal : 0), 4);
          args.push(a);
        }
        s.write(packet(T.GET_POINT, Buffer.concat([head, ...args])));
        this.log(L(`账号 ${accountId} 登录，查询点券：${bal}`, `Account ${accountId} logged in, points balance: ${bal}`));
        break;
      }
      case T.BUY:
        await this.onBuy(s, connKey, d);
        break;
      case T.DELETE_ITEMS:
        await this.onDelivered(d);
        break;
      default:
        this.log(L(`收到未知类型 0x${type.toString(16)}（${d.length} 字节），忽略`, `Unknown packet type 0x${type.toString(16)} (${d.length} bytes), ignored`));
    }
  }
}
