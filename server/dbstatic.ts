// 静态数据库: item table from data/db_items.json, built by tools/build_db_items.py (server items.xml + client strings).
// Like items_cache.json it is game data, generated per install and not shipped with the code.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.ts';
import { LError } from './i18n.ts';

export type DbItem = {
  id: number; k: string; zh: string; en: string; lv: number; q: string;
  race: number;                     // 0 天族, 1 魔族, 2 both
  c: string[];                      // menu routes without the 'item/' prefix, e.g. armor/chain/chest
  st?: Record<string, string>;      // bonus stats: key -> value ('120', '5%')
  ic?: string;                      // icon name: public/icons/item/<ic>.png (tools/build_db_icons.py)
  h?: 1;                            // npc-only / test item
};

const FILE = path.join(ROOT, 'data', 'db_items.json');
let cache: { mtime: number; items: DbItem[]; byId: Map<number, DbItem>; labels: Record<string, string> } | null = null;

// Reloaded when the file changes, so rebuilding it does not need a restart.
function load() {
  if (!fs.existsSync(FILE)) {
    throw new LError('没有静态数据 data/db_items.json：先用 tools/build_db_items.py 从服务端和客户端文件生成（见 README）',
      'No static data data/db_items.json: generate it from your server and client files with tools/build_db_items.py (see README)');
  }
  const mtime = fs.statSync(FILE).mtimeMs;
  if (!cache || cache.mtime !== mtime) {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const items: DbItem[] = raw.items ?? [];
    cache = { mtime, items, byId: new Map(items.map((x) => [x.id, x])), labels: raw.stats ?? {} };
  }
  return cache;
}

export type ItemQuery = {
  cat: string; lvMin?: number; lvMax?: number; races: number[]; qualities: string[]; stats: string[];
  search: string; hidden: boolean; page: number; size: number;
  sort?: 'id' | 'lv'; desc?: boolean;          // default id ascending; level sorts fall back to id
};

const inCat = (it: DbItem, cat: string) => !cat || it.c.some((c) => c === cat || c.startsWith(cat + '/'));

export function queryItems(q: ItemQuery) {
  const { items, labels } = load();
  const s = q.search.trim().toLowerCase();
  // items of the category (before the stat filter) decide which stat tags the page offers
  const base = items.filter((it) => (q.hidden || !it.h) && inCat(it, q.cat));
  const statCount = new Map<string, number>();
  for (const it of base) for (const k of Object.keys(it.st ?? {})) statCount.set(k, (statCount.get(k) ?? 0) + 1);
  const rows = base.filter((it) =>
    (q.lvMin === undefined || it.lv >= q.lvMin) && (q.lvMax === undefined || it.lv <= q.lvMax)
    && (!q.races.length || it.race === 2 || q.races.includes(it.race))
    && (!q.qualities.length || q.qualities.includes(it.q))
    && q.stats.every((k) => it.st && k in it.st)
    && (!s || String(it.id).startsWith(s) || it.zh.toLowerCase().includes(s) || it.en.toLowerCase().includes(s) || it.k.toLowerCase().includes(s)));
  const dir = q.desc ? -1 : 1;
  if (q.sort === 'lv') rows.sort((a, b) => (a.lv - b.lv) * dir || a.id - b.id);
  else if (q.desc) rows.sort((a, b) => b.id - a.id);   // the file is already in id order
  const size = Math.min(Math.max(q.size, 1), 100);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(Math.max(q.page, 1), pages);
  return {
    total: rows.length, page, pages, size, sort: q.sort === 'lv' ? 'lv' : 'id', desc: !!q.desc,
    rows: rows.slice((page - 1) * size, page * size).map(({ id, k, zh, en, lv, q: quality, race, ic }) => ({ id, k, zh, en, lv, q: quality, race, ic })),
    stats: [...statCount].sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, label: labels[key] ?? key, n })),
  };
}

export function getItem(id: number) {
  const { byId, labels } = load();
  const it = byId.get(id);
  return it ? { ...it, statLabels: Object.fromEntries(Object.keys(it.st ?? {}).map((k) => [k, labels[k] ?? k])) } : null;
}
