// Client for CacheD's interactive (GM) port, normally 127.0.0.1:2007 (CacheServer/common.xml interactivePort).
// Wire format, reversed from CacheD64.pdb (IntSocket::OnRead, GMPacketHandler, CacheToAdmin::Encode*):
//   request : u16 len (incl. itself) | u16 type (< 44) | u8 0xBC | u16 ~type | payload
//   reply   : u16 len | u16 type | u8 0xBD | u16 ~type | u16 result (0 = ok) [| extra]
import net from 'node:net';
import { LError } from './i18n.ts';

export const GQ = {
  ANNOUNCE: 6,
  MAIL_SEND: 34,
} as const;

const MARK_REQ = 0xbc;
const MARK_REP = 0xbd;

export type Reply = { type: number; result: number; raw: Buffer };

export function buildPacket(type: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(7);
  head.writeUInt16LE(7 + payload.length, 0);
  head.writeUInt16LE(type, 2);
  head.writeUInt8(MARK_REQ, 4);
  head.writeUInt16LE(~type & 0xffff, 5);
  return Buffer.concat([head, payload]);
}

export function request(host: string, port: number, type: number, payload: Buffer, timeoutMs = 5000): Promise<Reply> {
  const pkt = buildPacket(type, payload);
  if (pkt.length > 0x2000) return Promise.reject(new Error('packet too large for CacheD (max 8 KB)'));
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err: Error | null, rep?: Reply) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (err) reject(err); else resolve(rep!);
    };
    sock.setTimeout(timeoutMs, () => finish(new Error(`CacheD ${host}:${port} did not answer within ${timeoutMs} ms`)));
    sock.on('error', (e) => finish(new Error(`CacheD ${host}:${port}: ${e.message}`)));
    sock.on('connect', () => sock.write(pkt));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      const len = buf.readUInt16LE(0);
      if (buf.length < len) return;
      const raw = buf.subarray(0, len);
      if (len < 9 || raw[4] !== MARK_REP) return finish(new Error(`unexpected CacheD reply ${raw.toString('hex')}`));
      const rtype = raw.readUInt16LE(2);
      if (rtype !== type) return finish(new Error(`CacheD replied to type ${rtype}, expected ${type}`));
      finish(null, { type: rtype, result: raw.readUInt16LE(7), raw });
    });
    sock.on('close', () => finish(new Error('CacheD closed the connection without a reply')));
  });
}

function wstr(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.alloc(2)]);
}

export type AnnounceArgs = {
  text: string;
  position: 'M' | 'C';        // M = middle of the screen, C = chat window
  category: 'A' | 'E';        // A = normal announce, E = event announce
  raceMask: number;           // bit N set = race N receives (0 Elyos, 1 Asmodian); -1 = all
  classMask: number;          // bit N set = class N receives; -1 = all
};

// GQ_ANNOUNCE payload: u8 position | u8 category | utf16 text\0 (<= 255 chars) | i32 raceMask | i32 classMask.
// Server64 RP_GM_ANNOUNCE -> UserDB::BroadcastRaceClass tests both masks per user; a 0 mask reaches nobody.
export async function announce(host: string, port: number, a: AnnounceArgs): Promise<Reply> {
  const text = a.text.trim();
  if (!text) throw new LError('公告内容不能为空', 'The announcement text is empty');
  if (text.length > 255) throw new LError('公告最多 255 个字', 'An announcement can have at most 255 characters');
  const tail = Buffer.alloc(8);
  tail.writeInt32LE(a.raceMask | 0, 0);
  tail.writeInt32LE(a.classMask | 0, 4);
  const payload = Buffer.concat([Buffer.from(a.position + a.category, 'latin1'), wstr(text), tail]);
  return request(host, port, GQ.ANNOUNCE, payload);
}

export type MailSendArgs = {
  fromId: number; fromName: string; toId: number; toName: string; title: string; content: string;
  itemDbId: number;   // 0 = CacheD creates a fresh item from nameId/amount; else copy this user_item row (keeps enchant/stones)
  nameId: number; amount: number; money: number; express: boolean;
};

// GQ_MAIL_SEND (34), CacheD GMPacketHandler 0x140021460:
//   u16 world | u32 from_id | wstr from_name(<=25) | u32 to_id | wstr to_name(<=25) | wstr title(<=20) | wstr content(<=1000)
//   | i32 item_db_id | u32 name_id | i32 amount | i64 money | u16 express
// item_db_id == 0 && name_id != 0 -> WriteMail_NewItem (ItemDb::AddItem + aion_MailWrite)
// otherwise -> WriteMail: ItemDb::FindItem(item_db_id) (memory, else aion_GetItem from DB), AddItem copies it, aion_MailWrite.
// Then, if the receiver is online, CacheD tells the main server (packet 0x40) so the mail shows up immediately.
// The reply is always result 0, so callers must check user_mail themselves.
export async function mailSend(host: string, port: number, a: MailSendArgs): Promise<Reply> {
  const clip = (s: string, n: number) => [...s].slice(0, n).join('');
  const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  const i32 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32LE(v | 0); return b; };
  const i64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(Math.trunc(v))); return b; };
  const payload = Buffer.concat([
    u16(1), u32(a.fromId), wstr(clip(a.fromName, 25)), u32(a.toId), wstr(clip(a.toName, 25)),
    wstr(clip(a.title, 20)), wstr(clip(a.content, 1000)),
    i32(a.itemDbId), u32(a.nameId), i32(a.amount), i64(a.money), u16(a.express ? 1 : 0),
  ]);
  return request(host, port, GQ.MAIL_SEND, payload);
}
