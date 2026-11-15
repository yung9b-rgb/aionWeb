// Passive TCP reconstruction and Aion 2.7 decoding. Never creates sockets or emits game packets.
export type Segment = { src: string; dst: string; sport: number; dport: number; seq: number; flags: number; data: Buffer };
export function address(b: Buffer): string {
  if (b.length === 4) return [...b].join('.');
  return new URL(`http://[${Array.from({length: 8}, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(':')}]`).hostname.slice(1, -1);
}
export function parseFrame(b: Buffer, link: number): Segment | null {
  let off = 0;
  if (link === 1) {
    if (b.length < 14) return null;
    let ether = b.readUInt16BE(12); off = 14;
    for (let i = 0; i < 2 && (ether === 0x8100 || ether === 0x88a8); i++) {
      if (b.length < off + 4) return null;
      ether = b.readUInt16BE(off + 2); off += 4;
    }
    if (ether !== 0x800 && ether !== 0x86dd) return null;
  } else if (link === 0) off = 4;
  else if (link !== 12 && link !== 101) return null;
  if (b.length < off + 20) return null;
  let src: string, dst: string, end: number;
  if ((b[off] >> 4) === 4) {
    const size = (b[off] & 15) * 4, total = b.readUInt16BE(off + 2);
    if (size < 20 || total < size + 20 || off + total > b.length || b[off + 9] !== 6) return null;
    if (b.readUInt16BE(off + 6) & 0x3fff) return null; // fragments cannot be decoded as TCP segments
    src = address(b.subarray(off + 12, off + 16)); dst = address(b.subarray(off + 16, off + 20));
    end = off + total; off += size;
  } else if ((b[off] >> 4) === 6) {
    if (b.length < off + 40) return null;
    end = off + 40 + b.readUInt16BE(off + 4); if (end > b.length) return null;
    src = address(b.subarray(off + 8, off + 24)); dst = address(b.subarray(off + 24, off + 40));
    let next = b[off + 6]; off += 40;
    for (let i = 0; i < 8 && next !== 6; i++) {
      if (![0, 43, 60, 51].includes(next) || off + 2 > end) return null;
      const size = next === 51 ? (b[off + 1] + 2) * 4 : (b[off + 1] + 1) * 8;
      next = b[off]; off += size;
    }
    if (next !== 6) return null;
  } else return null;
  if (off + 20 > end) return null;
  const size = (b[off + 12] >> 4) * 4;
  if (size < 20 || off + size > end) return null;
  return { src, dst, sport: b.readUInt16BE(off), dport: b.readUInt16BE(off + 2), seq: b.readUInt32BE(off + 4), flags: b[off + 13], data: b.subarray(off + size, end) };
}

const SK = Buffer.from('nKO/WctQ0AVLbpzfBkS6NevDYT8ourG5CRlmdjyJ72aswx4EPq1UgZhFMXH?3iI9', 'latin1');
export const COMBAT_IDX = new Set([3, 4, 5, 6, 14, 22, 25, 32, 33, 37, 40, 41, 42, 43, 49, 50, 54, 59, 70, 81, 115, 160, 198, 208]);
const C_INDEX = new Map<number, number>();
for (let i = 0; i < 512; i++) C_INDEX.set(((((i + 0xbe) ^ 0xff) + 12) ^ 0xbf) & 65535, i);
const decode = (c: Buffer, k: Buffer) => {
  const p = Buffer.allocUnsafe(c.length); p[0] = c[0] ^ k[0];
  for (let i = 1; i < c.length; i++) p[i] = c[i] ^ SK[i & 63] ^ k[i & 7] ^ c[i - 1];
  k.writeBigUInt64LE((k.readBigUInt64LE() + BigInt(c.length)) & 0xffffffffffffffffn);
  return p;
};
type Direction = { next: number | null; pending: {seq: number; data: Buffer}[]; bytes: number; gap: number; framed: Buffer; key: Buffer | null };
type Session = { id: number; syn: number; time: number; c: Direction; s: Direction; ready: boolean; failed: boolean; fin: number };
const direction = (): Direction => ({next: null, pending: [], bytes: 0, gap: 0, framed: Buffer.alloc(0), key: null});
export type Packet = { id: number; direction: 'C' | 'S'; idx: number; body: Buffer };
export class Decoder {
  sessions = new Map<string, Session>();
  serial = 0;
  commands = 0;
  lost = 0;
  ignored = 0;
  host: string;
  port: number;
  packet: (p: Packet) => void;
  log: (category: 'conn' | 'err', text: string) => void;
  constructor(host: string, port: number, packet: (p: Packet) => void, log: Decoder['log']) {
    this.host = host.includes(':') ? new URL(`http://[${host}]`).hostname.slice(1, -1) : host;
    this.port = port; this.packet = packet; this.log = log;
  }
  get clients() { return [...this.sessions.values()].filter(s => !s.failed && s.ready).length; }
  get waiting() { return [...this.sessions.values()].filter(s => !s.failed && !s.ready).length; }
  invalidate(s: Session, why: string) {
    if (s.failed) return;
    s.failed = true; s.c = direction(); s.s = direction(); this.lost++;
    this.log('err', `[${s.id}] 监听失步：${why}；此连接停止解码，请重连游戏。`);
  }
  dropAll(why: string) { for (const s of this.sessions.values()) this.invalidate(s, why); }
  sweep(now = Date.now()) {
    for (const [key, s] of this.sessions) {
      if ((s.c.gap && now - s.c.gap > 5000) || (s.s.gap && now - s.s.gap > 5000)) this.invalidate(s, 'TCP 缺口超过 5 秒');
      if (now - s.time > 300000) this.sessions.delete(key);
    }
  }
  feed(t: Segment, now = Date.now()) {
    const fromServer = t.src === this.host && t.sport === this.port;
    if (!fromServer && !(t.dst === this.host && t.dport === this.port)) return;
    const key = fromServer ? `${t.dst}:${t.dport}` : `${t.src}:${t.sport}`;
    let s = this.sessions.get(key);
    if (!fromServer && (t.flags & 2) && !(t.flags & 16)) {
      if (!s || s.syn !== t.seq) {
        if (this.sessions.size >= 2048) { this.ignored++; return; }
        s = {id: ++this.serial, syn: t.seq, time: now, c: direction(), s: direction(), ready: false, failed: false, fin: 0};
        s.c.next = (t.seq + 1) >>> 0;
        this.sessions.set(key, s); this.log('conn', `[${s.id}] 捕获新连接 ${key}`);
      }
    }
    if (!s) { if (t.data.length) this.ignored++; return; } // never guess a mid-session cipher key
    s.time = now;
    if (t.flags & 4) { this.sessions.delete(key); this.log('conn', `[${s.id}] 连接关闭 (RST)`); return; }
    if (s.failed) { if (t.flags & 1) this.sessions.delete(key); return; }
    const d = fromServer ? s.s : s.c;
    let seq = (t.seq + ((t.flags & 2) ? 1 : 0)) >>> 0;
    if (d.next === null) {
      if (!(t.flags & 2)) { this.invalidate(s, '未捕获 TCP 握手'); return; }
      d.next = seq;
    }
    if (t.data.length) {
      let data = t.data, delta = (seq - d.next) | 0;
      if (delta < 0) { const skip = Math.min(-delta, data.length); data = data.subarray(skip); seq = (seq + skip) >>> 0; delta = (seq - d.next) | 0; }
      if (data.length) {
        if (delta > 0) {
          if (!d.pending.some(p => p.seq === seq && p.data.equals(data))) {
            d.pending.push({seq, data: Buffer.from(data)}); d.bytes += data.length;
          }
          if (!d.gap) d.gap = now;
          const total = [...this.sessions.values()].reduce((n, x) => n + x.c.bytes + x.s.bytes, 0);
          if (d.bytes > 1048576 || d.pending.length > 256 || total > 16777216) this.invalidate(s, '重组缓冲已满');
        } else {
          this.consume(s, d, fromServer, data); d.next = (d.next + data.length) >>> 0;
          while (d.pending.length && !s.failed) {
            d.pending.sort((a, b) => ((a.seq - d.next!) | 0) - ((b.seq - d.next!) | 0));
            const p = d.pending[0], diff = (p.seq - d.next) | 0;
            if (diff > 0) break;
            d.pending.shift(); d.bytes -= p.data.length;
            const rest = p.data.subarray(Math.min(-diff, p.data.length));
            if (rest.length) { this.consume(s, d, fromServer, rest); d.next = (d.next + rest.length) >>> 0; }
          }
          if (!d.pending.length) d.gap = 0;
        }
      }
    }
    if (t.flags & 1) { s.fin |= fromServer ? 2 : 1; if (s.fin === 3) { this.sessions.delete(key); this.log('conn', `[${s.id}] 连接关闭 (FIN)`); } }
  }
  consume(s: Session, d: Direction, fromServer: boolean, data: Buffer) {
    if (d.framed.length + data.length > 1048576) { this.invalidate(s, '报文缓冲已满'); return; }
    d.framed = Buffer.concat([d.framed, data]);
    while (d.framed.length >= 2 && !s.failed) {
      const len = d.framed.readUInt16LE();
      if (len < 7) { this.invalidate(s, '报文长度不合法'); return; }
      if (d.framed.length < len) return;
      const body = d.framed.subarray(2, len); d.framed = d.framed.subarray(len);
      if (fromServer && !s.ready) {
        if (len !== 11 || body.readUInt16LE() !== 0x1f9 || body[2] !== 0x54) { this.invalidate(s, '不是完整 SM_KEY 首包'); return; }
        const k = Buffer.from('00000000a16c5487', 'hex');
        k.writeUInt32LE((((body.readUInt32LE(5) - 0x3ff2cc87) >>> 0) ^ 0xcd92e451) >>> 0);
        s.c.key = Buffer.from(k); s.s.key = k; s.ready = true;
        this.log('conn', `[${s.id}] 已捕获 SM_KEY，开始解码`);
        // Capture callbacks can deliver C data before the S key; resume its buffered stream.
        if (s.c.framed.length) this.consume(s, s.c, false, Buffer.alloc(0));
        continue;
      }
      if (!d.key) { d.framed = Buffer.concat([Buffer.from([len & 255, len >> 8]), body, d.framed]); return; }
      const p = decode(body, d.key), op = p.readUInt16LE();
      if (p[2] !== (fromServer ? 0x54 : 0x55) || p.readUInt16LE(3) !== ((~op) & 65535)) { this.invalidate(s, '解密包头校验失败'); return; }
      const idx = fromServer ? ((op ^ 255) - 0xbe) & 65535 : C_INDEX.get(op);
      if (idx === undefined || idx > 511) { this.invalidate(s, '操作码不合法'); return; }
      if (!fromServer && idx === 41) this.commands++;
      this.packet({id: s.id, direction: fromServer ? 'S' : 'C', idx, body: p});
    }
  }
}
