// "Shop server" for the in-game cash shop catalog (Server64 ShopClient / ShopSocket / ShopDB), hosted in the admin process.
// Server64 connects to MainServer/common.xml <shopServerAddr>:<shopServerPort> and pulls the catalog from us.
// Wire format (reversed from Server64.pdb: ShopSocket::OnRead, g_shopPacketTable, ShopToServer::Decode*, ServerToShop::Encode*):
//   Server64 -> shop: u16 len | u8 type | 0xDC | u8 ~type | payload    0 ConnectAck(u32 serverId), 1 RequestData(u32 seq)
//   shop -> Server64: u16 len | u8 type | 0xDD | u8 ~type | payload    (type < 10, len-2 <= 0x2000)
//     0 ConnectResult(u8 0)  1 NotifyUpdate  2 UpdateStart  3 GoodsList  4 CategoryList  5 GoodsCategoryList
//     6 RankingList  7 PromotionList  9 UpdateEnd
//     list payload: u32 seq (must echo RequestData) | i16 count | |count| x fixed-size struct (memcpy'd by Server64);
//     count < 0 (or 0) = last chunk of that list (required, or the category tree is never built)
// Struct layouts come from the PDB type records (ShopGoodsInfo 0x248, ShopCategoryInfo 0x78, ShopGoodsCategoryInfo 0x18,
// ShopRankingInfo 0x20, ShopPromotionInfo 0x28); wchar arrays are sized in BYTES (goodsName 102 B = 50 chars + NUL).
import net from 'node:net';
import type { ShopDb } from './shopdb.ts';
import { L, pick, type Lang, type Msg } from './i18n.ts';

const MARK_IN = 0xdc, MARK_OUT = 0xdd;
const T = { CONNECT_RESULT: 0, NOTIFY_UPDATE: 1, UPDATE_START: 2, GOODS: 3, CATEGORY: 4, GOODS_CATEGORY: 5, RANKING: 6, PROMOTION: 7, UPDATE_END: 9 };
const PER_PACKET = 12;   // 12 x 584 B goods fit the 8 KB packet limit

export type ShopCategory = { categoryId: number; parentId: number; categoryName: string; displayOrder: number; enabled?: boolean };
export type ShopGoods = {
  goodsId: number; goodsName: string; salePrice: number; priceCategory: number; priceId: number; saleEnableQuantity: number;
  saleStatusCode: number; itemTypeCode: number; gameItemKey: number; desc: string; goodsIconKey: number; goodsIconBitSet: number;
  itemDuration: number; itemAmount: number; availStart: number; availEnd: number; enabled?: boolean;
  categories: Array<{ categoryId: number; displayOrder: number }>;
};
export type ShopRanking = { rankingTypeCode: number; ranking: number; goodsId: number };
export type ShopPromotion = { promotionId: number; goodsId: number; availStart: number; availEnd: number };
export type ShopCatalog = { categories: ShopCategory[]; goods: ShopGoods[]; rankings: ShopRanking[]; promotions: ShopPromotion[] };

export const SAMPLE_CATALOG: ShopCatalog = {
  categories: [
    { categoryId: 1, parentId: 0, categoryName: '消耗品', displayOrder: 1 },
    { categoryId: 2, parentId: 0, categoryName: '装备', displayOrder: 2 },
  ],
  goods: [
    { goodsId: 1001, goodsName: '达弥努的符咒 II', salePrice: 100, priceCategory: 1, priceId: 1, saleEnableQuantity: 9999,
      saleStatusCode: 1, itemTypeCode: 0, gameItemKey: 169620012, desc: '测试商品：消耗品', goodsIconKey: 0, goodsIconBitSet: 0,
      itemDuration: 0, itemAmount: 1, availStart: 0, availEnd: 0, categories: [{ categoryId: 1, displayOrder: 1 }] },
    { goodsId: 1002, goodsName: '图拉突之盾', salePrice: 5000, priceCategory: 1, priceId: 1, saleEnableQuantity: 9999,
      saleStatusCode: 1, itemTypeCode: 0, gameItemKey: 115000985, desc: '测试商品：54 级史诗盾', goodsIconKey: 0, goodsIconBitSet: 0,
      itemDuration: 0, itemAmount: 1, availStart: 0, availEnd: 0, categories: [{ categoryId: 2, displayOrder: 1 }] },
  ],
  rankings: [{ rankingTypeCode: 1, ranking: 1, goodsId: 1002 }],
  promotions: [],
};

function wfixed(buf: Buffer, off: number, bytes: number, s: string) {
  const b = Buffer.from(s ?? '', 'utf16le');
  b.copy(buf, off, 0, Math.min(b.length, bytes - 2) & ~1);   // keep room for the NUL; buffer is zero-filled
}
const nowSec = () => Math.floor(Date.now() / 1000);

function encGoods(g: ShopGoods): Buffer {
  const b = Buffer.alloc(0x248);
  b.writeInt32LE(g.goodsId, 0x000);
  wfixed(b, 0x004, 102, g.goodsName);
  b.writeInt32LE(g.salePrice, 0x06c);
  b.writeInt32LE(g.priceCategory, 0x070);
  b.writeInt32LE(g.priceId, 0x074);
  b.writeInt32LE(g.saleEnableQuantity, 0x078);
  b.writeInt16LE(g.saleStatusCode, 0x07c);
  b.writeInt16LE(g.itemTypeCode, 0x07e);
  b.writeInt32LE(g.gameItemKey, 0x080);
  wfixed(b, 0x084, 402, g.desc);
  b.writeBigInt64LE(BigInt(g.goodsIconKey), 0x218);
  b.writeInt32LE(g.goodsIconBitSet, 0x220);
  b.writeInt32LE(g.itemDuration, 0x224);       // seconds (Server64 shows itemDuration / 3600 hours)
  b.writeInt32LE(g.itemAmount, 0x228);
  b.writeBigInt64LE(BigInt(g.availStart), 0x230);
  b.writeBigInt64LE(BigInt(g.availEnd), 0x238);
  b.writeBigInt64LE(BigInt(nowSec()), 0x240);  // registerDate
  return b;
}

function encCategory(c: ShopCategory): Buffer {
  const b = Buffer.alloc(0x78);
  b.writeInt32LE(c.categoryId, 0x00);
  b.writeInt32LE(c.parentId, 0x04);
  wfixed(b, 0x08, 102, c.categoryName);
  b.writeInt16LE(c.displayOrder, 0x6e);
  b.writeBigInt64LE(BigInt(nowSec()), 0x70);
  return b;
}

function encGoodsCategory(goodsId: number, categoryId: number, displayOrder: number): Buffer {
  const b = Buffer.alloc(0x18);
  b.writeInt32LE(goodsId, 0x00);
  b.writeInt32LE(categoryId, 0x04);
  b.writeInt16LE(displayOrder, 0x08);
  b.writeBigInt64LE(BigInt(nowSec()), 0x10);
  return b;
}

function encRanking(r: ShopRanking): Buffer {
  const b = Buffer.alloc(0x20);
  b.writeInt16LE(r.rankingTypeCode, 0x00);
  b.writeInt32LE(r.ranking, 0x04);
  b.writeInt32LE(r.goodsId, 0x08);
  b.writeBigInt64LE(BigInt(nowSec()), 0x18);   // 0x10 is a ShopGoodsInfo* that Server64 fills in itself
  return b;
}

function encPromotion(p: ShopPromotion): Buffer {
  const b = Buffer.alloc(0x28);
  b.writeInt32LE(p.goodsId, 0x00);
  b.writeInt32LE(p.promotionId, 0x04);
  b.writeBigInt64LE(BigInt(p.availStart), 0x10);
  b.writeBigInt64LE(BigInt(p.availEnd), 0x18);
  b.writeBigInt64LE(BigInt(nowSec()), 0x20);
  return b;
}

function packet(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.alloc(5);
  h.writeUInt16LE(5 + payload.length, 0);
  h.writeUInt8(type, 2);
  h.writeUInt8(MARK_OUT, 3);
  h.writeUInt8(~type & 0xff, 4);
  return Buffer.concat([h, payload]);
}

// The i16 count's SIGN marks the last chunk of a list: ShopDB::Load*Packet takes abs(count) and only builds the
// category tree / goods links when count <= 0 (LoadCategoryPacket +0x16b: "neg ax; mov r12b,1"). So the final chunk
// carries -n (an empty list is a single chunk with 0, which also counts as final).
function listPackets(type: number, seq: number, structs: Buffer[]): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < Math.max(structs.length, 1); i += PER_PACKET) {
    const chunk = structs.slice(i, i + PER_PACKET);
    const last = i + PER_PACKET >= structs.length;
    const head = Buffer.alloc(6);
    head.writeUInt32LE(seq >>> 0, 0);
    head.writeInt16LE(last ? -chunk.length : chunk.length, 4);
    out.push(packet(type, Buffer.concat([head, ...chunk])));
  }
  return out;
}

export type ShopLog = { seq: number; t: number; text: Msg };

export class ShopServer {
  host: string; port: number;
  private db: ShopDb;
  private server: net.Server | null = null;
  private conns = new Set<net.Socket>();
  private logs: ShopLog[] = [];
  private logSeq = 0;
  lastError: Msg | null = null;
  lastSync: number | null = null;
  serverId: number | null = null;

  constructor(host: string, port: number, db: ShopDb) {
    this.host = host; this.port = port; this.db = db;
  }

  get running() { return !!this.server?.listening; }
  get connections() { return this.conns.size; }

  log(text: Msg) {
    this.logs.push({ seq: ++this.logSeq, t: Date.now(), text });
    if (this.logs.length > 500) this.logs.shift();
  }
  logsSince(since: number, lang: Lang = 'zh') { return this.logs.filter((l) => l.seq > since).map((l) => ({ ...l, text: pick(l.text, lang) })); }

  // The catalog lives in AionShop (shop_category / shop_goods / shop_goods_category / shop_ranking / shop_promotion).
  loadCatalog(): Promise<ShopCatalog> { return this.db.loadCatalog(); }
  saveCatalog(c: ShopCatalog): Promise<void> { return this.db.saveCatalog(c); }

  // What the game gets: only enabled categories and enabled goods, and only links/rankings between those.
  static forGame(c: ShopCatalog): ShopCatalog {
    const cats = c.categories.filter((x) => x.enabled !== false);
    const catIds = new Set(cats.map((x) => x.categoryId));
    const goods = c.goods.filter((g) => g.enabled !== false)
      .map((g) => ({ ...g, categories: (g.categories ?? []).filter((x) => catIds.has(x.categoryId)) }));
    const goodsIds = new Set(goods.map((g) => g.goodsId));
    return { categories: cats, goods,
      rankings: (c.rankings ?? []).filter((r) => goodsIds.has(r.goodsId)),
      promotions: (c.promotions ?? []).filter((r) => goodsIds.has(r.goodsId)) };
  }

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
        this.log(L(`商城服务器已启动 ${this.host}:${this.port}，等待主服务器连接`, `Shop server started on ${this.host}:${this.port}, waiting for the main server`));
        resolve();
      });
    });
  }

  // Tell every connected Server64 the catalog changed: it answers with RequestData and we resend everything.
  notifyUpdate(): number {
    for (const s of this.conns) s.write(packet(T.NOTIFY_UPDATE));
    this.log(L(`已通知 ${this.conns.size} 个主服务器重新拉取目录`, `Told ${this.conns.size} main server(s) to fetch the catalog again`));
    return this.conns.size;
  }

  private onConn(s: net.Socket) {
    this.conns.add(s);
    this.log(L(`主服务器已连接 ${s.remoteAddress}:${s.remotePort}`, `Main server connected from ${s.remoteAddress}:${s.remotePort}`));
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const len = buf.readUInt16LE(0);
        if (len < 5 || buf.length < len) { if (len < 5 && buf.length >= 2) { this.log(L(`异常包长度 ${len}，断开`, `Bad packet length ${len}, disconnecting`)); s.destroy(); } break; }
        const p = buf.subarray(0, len);
        buf = buf.subarray(len);
        this.onPacket(s, p);
      }
    });
    const bye = (why: Msg) => { if (this.conns.delete(s)) this.log(L(`主服务器连接断开：${pick(why, 'zh')}`, `Main server disconnected: ${pick(why, 'en')}`)); };
    s.on('close', () => bye(L('关闭', 'closed')));
    s.on('error', (e) => bye(e.message));
  }

  private onPacket(s: net.Socket, p: Buffer) {
    const type = p[2], mark = p[3], inv = p[4];
    if (mark !== MARK_IN || (inv ^ 0xff) !== type) { this.log(L(`包头不对 type=${type} mark=${mark.toString(16)}，忽略`, `Bad packet header type=${type} mark=${mark.toString(16)}, ignored`)); return; }
    if (type === 0) {
      this.serverId = p.length >= 9 ? p.readInt32LE(5) : null;
      this.log(L(`收到握手（服务器编号 ${this.serverId}），回复握手结果`, `Handshake received (server ${this.serverId}), answered`));
      s.write(packet(T.CONNECT_RESULT, Buffer.from([0])));
    } else if (type === 1) {
      const seq = p.readUInt32LE(5);
      this.sendCatalog(s, seq).catch((e) => this.log(L(`读取目录失败：${e.message}`, `Reading the catalog failed: ${e.message}`)));
    } else {
      this.log(L(`收到未知类型 ${type}，忽略`, `Unknown packet type ${type}, ignored`));
    }
  }

  private async sendCatalog(s: net.Socket, seq: number) {
    const cat = ShopServer.forGame(await this.loadCatalog());
    const gc = cat.goods.flatMap((g) => (g.categories ?? []).map((c) => encGoodsCategory(g.goodsId, c.categoryId, c.displayOrder)));
    const pkts = [
      packet(T.UPDATE_START),
      ...listPackets(T.CATEGORY, seq, cat.categories.map(encCategory)),
      ...listPackets(T.GOODS, seq, cat.goods.map(encGoods)),
      ...listPackets(T.GOODS_CATEGORY, seq, gc),
      ...listPackets(T.RANKING, seq, (cat.rankings ?? []).map(encRanking)),
      ...listPackets(T.PROMOTION, seq, (cat.promotions ?? []).map(encPromotion)),
      packet(T.UPDATE_END),
    ];
    s.write(Buffer.concat(pkts));
    this.lastSync = Date.now();
    const nc = cat.categories.length, ng = cat.goods.length, nr = (cat.rankings ?? []).length, np = (cat.promotions ?? []).length;
    this.log(L(`收到请求数据（序号 ${seq}），已发送 分类 ${nc}、商品 ${ng}、对应 ${gc.length}、排行 ${nr}、推荐 ${np}（共 ${pkts.length} 个包）`,
      `Catalog requested (seq ${seq}): sent ${nc} categories, ${ng} goods, ${gc.length} links, ${nr} rankings, ${np} promotions (${pkts.length} packets)`));
  }
}
