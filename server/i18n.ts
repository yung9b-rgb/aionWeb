// Bilingual messages for the admin (zh / en). Server texts that reach the browser (errors, service logs,
// validation results) are kept as { zh, en } and resolved per request; the browser sends its UI language
// in the X-Lang header. Plain strings pass through unchanged (data such as names, raw error messages).
import type http from 'node:http';

export type Lang = 'zh' | 'en';
export type Msg = string | { zh: string; en: string };

export const L = (zh: string, en: string): Msg => ({ zh, en });

export function pick(m: Msg | null | undefined, lang: Lang): string {
  if (m == null) return '';
  return typeof m === 'string' ? m : m[lang] ?? m.zh;
}

// An Error that carries both languages; .message is the Chinese text (console logs stay Chinese).
export class LError extends Error {
  msg: { zh: string; en: string };
  constructor(zh: string, en: string) { super(zh); this.msg = { zh, en }; }
}

export function errMsg(e: any): Msg {
  if (e instanceof LError) return e.msg;
  if (e && typeof e === 'object' && e.msg && typeof e.msg === 'object' && 'zh' in e.msg) return e.msg;
  return e?.message ?? String(e);
}

export function langOf(req: http.IncomingMessage, url?: URL): Lang {
  const v = String(req.headers['x-lang'] ?? url?.searchParams.get('lang') ?? '').toLowerCase();
  return v.startsWith('en') ? 'en' : 'zh';
}
