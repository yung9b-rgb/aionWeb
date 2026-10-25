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

// ---- 掉落组: data/db_dropgroups.json, built by tools/build_db_dropgroups.py (CommonDropItems.xml + npcs.xml) ----
// weight is per roll in 1/10,000,000 at adjustment 100; a referencing NPC scales it by its common_drop_adjustment / 100.
type DropGroup = { id: number; name: string; items: Array<[number | string, number]>; users: number; npcs: number[] };
const GROUPS_FILE = path.join(ROOT, 'data', 'db_dropgroups.json');
let groupCache: { mtime: number; groups: DropGroup[]; byId: Map<number, DropGroup> } | null = null;

function loadGroups() {
  if (!fs.existsSync(GROUPS_FILE)) {
    throw new LError('没有掉落组数据 data/db_dropgroups.json：先用 tools/build_db_dropgroups.py 生成（见 README）',
      'No drop-group data data/db_dropgroups.json: generate it with tools/build_db_dropgroups.py (see README)');
  }
  const mtime = fs.statSync(GROUPS_FILE).mtimeMs;
  if (!groupCache || groupCache.mtime !== mtime) {
    const groups: DropGroup[] = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8')).groups ?? [];
    groupCache = { mtime, groups, byId: new Map(groups.map((g) => [g.id, g])) };
  }
  return groupCache;
}

export function queryGroups(q: { search: string; page: number; size: number; sort?: 'id' | 'items' | 'users'; desc?: boolean }) {
  const { groups } = loadGroups();
  const s = q.search.trim().toLowerCase();
  // search matches the group id / name, or any item in the group (id, Chinese, English or internal name)
  const { byId } = s ? load() : { byId: new Map<number, DbItem>() };
  const itemHit = (iid: number | string) => {
    if (typeof iid === 'string') return iid.toLowerCase().includes(s);
    if (String(iid) === s) return true;
    const it = byId.get(iid);
    return !!it && (it.zh.toLowerCase().includes(s) || it.en.toLowerCase().includes(s) || it.k.toLowerCase().includes(s));
  };
  const rows = groups.filter((g) => !s || String(g.id) === s || g.name.toLowerCase().includes(s) || g.items.some(([iid]) => itemHit(iid)));
  const key = (g: DropGroup) => (q.sort === 'items' ? g.items.length : q.sort === 'users' ? g.users : g.id);
  const dir = q.desc ? -1 : 1;
  rows.sort((a, b) => (key(a) - key(b)) * dir || a.id - b.id);
  const size = Math.min(Math.max(q.size, 1), 100);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(Math.max(q.page, 1), pages);
  return {
    total: rows.length, page, pages, size, sort: q.sort ?? 'id', desc: !!q.desc,
    rows: rows.slice((page - 1) * size, page * size).map((g) => ({ id: g.id, name: g.name, items: g.items.length, users: g.users })),
  };
}

export function getGroup(id: number) {
  const g = loadGroups().byId.get(id);
  if (!g) return null;
  const { byId } = load();
  const total = g.items.reduce((n, [, w]) => n + w, 0);
  return {
    id: g.id, name: g.name, users: g.users, total,
    items: g.items.map(([iid, w]) => {
      const it = typeof iid === 'number' ? byId.get(iid) : undefined;
      return { id: typeof iid === 'number' ? iid : 0, k: it?.k ?? String(iid), zh: it?.zh ?? '', en: it?.en ?? '', lv: it?.lv ?? 0,
        q: it?.q ?? '', ic: it?.ic, weight: w };
    }),
  };
}
