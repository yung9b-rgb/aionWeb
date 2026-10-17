// GM-command proxy (port of AionServer/GMProxy/aion_gm_proxy.py), hosted inside the admin process.
// The game client connects to listenPort (7779; AuthD GameServer.portNo points there) and everything is forwarded to the
// main server (7777). A chat line starting with "//" (C_SAY, idx 27) is rewritten into C_BUILDER_COMMAND (idx 41).
// Encryption (2.7 / matching 2012 EU client): key from SM_KEY; C->S ciphertext chains on the previous byte and the 8-byte
// key rolls by packet size, so once a packet changes size we keep separate key states for "decrypt from client" and
// "encrypt to server".
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const SK = Buffer.from('nKO/WctQ0AVLbpzfBkS6NevDYT8ourG5CRlmdjyJ72aswx4EPq1UgZhFMXH?3iI9', 'latin1');
const M = 0xffff;
const C_SAY = 27, C_BUILDER_COMMAND = 41, S_MESSAGE = 24;

const srvCOp = (i: number) => ((((i + 0xbe) ^ 0xff) + 0x0c) ^ 0xbf) & M;   // client->server opcode of packet index i
const SRV_IDX = new Map<number, number>();
for (let i = 0; i < 0x200; i++) SRV_IDX.set(srvCOp(i), i);
const sDec = (op: number) => ((op ^ 0xff) - 0xbe) & M;

function decrypt(c: Buffer, k: Buffer): Buffer {
  const p = Buffer.alloc(c.length);
  if (!c.length) return p;
  p[0] = c[0] ^ k[0];
  for (let i = 1; i < c.length; i++) p[i] = c[i] ^ SK[i & 63] ^ k[i & 7] ^ c[i - 1];
  return p;
}

function encrypt(p: Buffer, k: Buffer): Buffer {
  const c = Buffer.alloc(p.length);
  if (!p.length) return c;
  c[0] = p[0] ^ k[0];
  for (let i = 1; i < p.length; i++) c[i] = p[i] ^ SK[i & 63] ^ k[i & 7] ^ c[i - 1];
  return c;
}

function roll(k: Buffer, size: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE((k.readBigUInt64LE(0) + BigInt(size)) & 0xffffffffffffffffn);
  return out;
}

function builderPacket(cmd: string): Buffer {
  const op = srvCOp(C_BUILDER_COMMAND);
  const head = Buffer.alloc(5);
  head.writeUInt16LE(op, 0);
  head.writeUInt8(0x55, 2);
  head.writeUInt16LE(~op & M, 3);
  return Buffer.concat([head, Buffer.from(cmd, 'utf16le'), Buffer.alloc(2)]);
}

const hex = (b: Buffer) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
const utf16z = (b: Buffer) => b.toString('utf16le').split('\0', 1)[0];

export type LogCat = 'gm' | 'conn' | 'pkt' | 'err';
export type LogLine = { seq: number; t: number; cat: LogCat; text: string };

export type ProxyOptions = { listenHost: string; listenPort: number; targetHost: string; targetPort: number; logDir: string };

type Sess = { id: number; cin: Buffer | null; sout: Buffer | null; sk: Buffer | null; first: boolean };

export class GmProxy {
  opt: ProxyOptions;
  logPackets = false;
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private lines: LogLine[] = [];
  private seq = 0;
  private cid = 0;
  private fileDay = '';
  private file: fs.WriteStream | null = null;
  startedAt: number | null = null;
  lastError: string | null = null;
  commands = 0;

  constructor(opt: ProxyOptions) { this.opt = opt; }

  get running(): boolean { return !!this.server?.listening; }
  get clients(): number { return Math.floor(this.sockets.size / 2); }

  log(cat: LogCat, text: string): void {
    if (cat === 'pkt' && !this.logPackets) return;
    const line = { seq: ++this.seq, t: Date.now(), cat, text };
    this.lines.push(line);
    if (this.lines.length > 4000) {
      // keep GM/connection lines longer than raw packet lines
      const pk = this.lines.findIndex((l) => l.cat === 'pkt');
      this.lines.splice(pk >= 0 && pk < this.lines.length - 500 ? pk : 0, 1);
    }
    this.writeFile(line);
  }

  private writeFile(l: LogLine): void {
    const d = new Date(l.t);
    const p2 = (n: number, w = 2) => String(n).padStart(w, '0');
    const day = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
    if (day !== this.fileDay) {
      this.file?.end();
      fs.mkdirSync(this.opt.logDir, { recursive: true });
      this.file = fs.createWriteStream(path.join(this.opt.logDir, `gm_${day}.log`), { flags: 'a', encoding: 'utf8' });
      this.fileDay = day;
    }
    this.file!.write(`${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p2(d.getMilliseconds(), 3)} [${l.cat}] ${l.text}\n`);
  }

  logsSince(since: number, includePackets: boolean): LogLine[] {
    return this.lines.filter((l) => l.seq > since && (includePackets || l.cat !== 'pkt'));
  }

  clearLogs(): void { this.lines = []; }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const srv = net.createServer((c) => this.onClient(c));
      srv.once('error', (e: NodeJS.ErrnoException) => {
        this.lastError = e.code === 'EADDRINUSE'
          ? `端口 ${this.opt.listenPort} 已被占用（独立的 GMProxy 窗口可能还开着，先关掉它）`
          : e.message;
        this.log('err', `启动失败：${this.lastError}`);
        this.server = null;
        reject(new Error(this.lastError));
      });
      srv.listen(this.opt.listenPort, this.opt.listenHost, () => {
        this.server = srv;
        this.startedAt = Date.now();
        this.lastError = null;
        this.log('conn', `代理已启动 ${this.opt.listenHost}:${this.opt.listenPort} -> ${this.opt.targetHost}:${this.opt.targetPort}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      for (const s of this.sockets) s.destroy();
      this.sockets.clear();
      this.server.close(() => resolve());
      this.server = null;
      this.startedAt = null;
      this.log('conn', '代理已停止（已断开所有游戏连接）');
    });
  }

  private onClient(c: net.Socket): void {
    const s: Sess = { id: ++this.cid, cin: null, sout: null, sk: null, first: true };
    const u = net.createConnection({ host: this.opt.targetHost, port: this.opt.targetPort });
    this.sockets.add(c); this.sockets.add(u);
    c.setNoDelay(true); u.setNoDelay(true);
    this.log('conn', `[${s.id}] 客户端 ${c.remoteAddress}:${c.remotePort} 已连接`);
    let closed = false;
    const close = (why: string) => {
      if (closed) return;
      closed = true;
      this.log('conn', `[${s.id}] 连接关闭：${why}`);
      c.destroy(); u.destroy();
      this.sockets.delete(c); this.sockets.delete(u);
    };
    c.on('end', () => close('客户端断开'));
    u.on('end', () => close('主服务器断开'));
    u.on('error', (e) => close(`连接主服务器失败/出错：${e.message}`));
    c.on('error', (e) => close(`客户端出错：${e.message}`));
    c.on('close', () => close('客户端断开'));
    u.on('close', () => close('主服务器断开'));
    this.pump(c, u, s, true);
    this.pump(u, c, s, false);
  }

  private pump(src: net.Socket, dst: net.Socket, s: Sess, c2s: boolean): void {
    let buf = Buffer.alloc(0);
    src.on('data', (data) => {
      buf = buf.length ? Buffer.concat([buf, data]) : data;
      const out: Buffer[] = [];
      while (buf.length >= 2) {
        const ln = buf.readUInt16LE(0);
        if (ln < 2 || buf.length < ln) break;
        const pkt = buf.subarray(0, ln);
        buf = buf.subarray(ln);
        try {
          out.push(c2s ? this.c2s(pkt, s) : this.s2c(pkt, s));
        } catch (e: any) {
          this.log('err', `[${s.id}] ${c2s ? 'C->S' : 'S->C'} 处理出错 ${e?.message}，原样转发`);
          out.push(pkt);
        }
      }
      if (out.length) dst.write(out.length === 1 ? out[0] : Buffer.concat(out));
    });
  }

  private c2s(pkt: Buffer, s: Sess): Buffer {
    if (!s.cin || !s.sout) return pkt;
    const body = pkt.subarray(2);
    const p = decrypt(body, s.cin);
    s.cin = roll(s.cin, body.length);
    const op = p.readUInt16LE(0);
    const idx = SRV_IDX.get(op) ?? -1;
    let outPlain = p;
    if (idx === C_SAY && p.length > 8) {
      const text = utf16z(p.subarray(6));
      if (text.startsWith('//') && text.length > 2) {
        const cmd = text.slice(2).trim();
        outPlain = builderPacket(cmd);
        this.commands++;
        this.log('gm', `[${s.id}] 聊天 "${text}" → GM 命令 "${cmd}"`);
      }
    }
    if (idx === C_BUILDER_COMMAND) this.log('gm', `[${s.id}] 客户端 GM 窗口命令 "${utf16z(p.subarray(5))}"`);
    const enc = encrypt(outPlain, s.sout);
    s.sout = roll(s.sout, outPlain.length);
    if (outPlain === p) this.log('pkt', `[${s.id}] C->S len=${pkt.length} idx=${idx} data=${hex(p.subarray(5, 37))}`);
    const head = Buffer.alloc(2);
    head.writeUInt16LE(enc.length + 2);
    return Buffer.concat([head, enc]);
  }

  private s2c(pkt: Buffer, s: Sess): Buffer {
    const body = pkt.subarray(2);
    if (s.first) {   // SM_KEY, sent in clear
      s.first = false;
      const sent = body.readUInt32LE(5);
      const b = (((sent - 0x3ff2cc87) >>> 0) ^ 0xcd92e451) >>> 0;
      const key = Buffer.alloc(8);
      key.writeUInt32LE(b, 0);
      Buffer.from([0xa1, 0x6c, 0x54, 0x87]).copy(key, 4);
      s.cin = Buffer.from(key); s.sout = Buffer.from(key); s.sk = Buffer.from(key);
      this.log('conn', `[${s.id}] 收到 SM_KEY，加密握手完成 baseKey=0x${b.toString(16).padStart(8, '0')}`);
      return pkt;
    }
    if (!s.sk) return pkt;
    const p = decrypt(body, s.sk);
    s.sk = roll(s.sk, body.length);
    const idx = sDec(p.readUInt16LE(0));
    if (idx === S_MESSAGE) this.log('gm', `[${s.id}] 服务器消息 "${utf16z(p.subarray(13))}"`);
    else this.log('pkt', `[${s.id}] S->C len=${pkt.length} idx=${idx} data=${hex(p.subarray(5, 37))}`);
    return pkt;
  }
}
