// Single-admin auth: scrypt password hash + HMAC-signed session cookie.
import crypto from 'node:crypto';

const SESSION_HOURS = 12;
export const COOKIE = 'aa_session';

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [kind, saltHex, hashHex] = stored.split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), want.length);
  return crypto.timingSafeEqual(want, got);
}

function sign(key: string, data: string): string {
  return crypto.createHmac('sha256', key).update(data).digest('base64url');
}

export function issueToken(key: string): string {
  const data = `${Date.now() + SESSION_HOURS * 3600_000}.${crypto.randomBytes(9).toString('base64url')}`;
  return `${data}.${sign(key, data)}`;
}

export function verifyToken(key: string, token: string | undefined): boolean {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const data = token.slice(0, i);
  const mac = Buffer.from(token.slice(i + 1));
  const want = Buffer.from(sign(key, data));
  if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) return false;
  return Number(data.split('.')[0]) > Date.now();
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const j = part.indexOf('=');
    if (j > 0) out[part.slice(0, j).trim()] = decodeURIComponent(part.slice(j + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`;
}

export const clearCookie = `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
