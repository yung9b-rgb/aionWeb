// 静态数据库: item table from data/db_items.json, built by tools/build_db_items.py (server items.xml + client strings).
// Like items_cache.json it is game data, generated per install and not shipped with the code.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.ts';
import { LError } from './i18n.ts';
import { baseSlots, maxEnchant, isGear, type ItemInfo } from './items.ts';

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

// Full field lists: data/db_items_raw.ndjson / db_npcs_raw.ndjson (one JSON object per line, written by the
// build_db_*.py tools). Only a byte-offset index per file is kept in memory; each detail request reads its one line.
const RAW_FILE = path.join(ROOT, 'data', 'db_items_raw.ndjson');
const rawIndexes = new Map<string, { mtime: number; at: Map<number, [number, number]> }>();

function rawLine(id: number, file = RAW_FILE): any | null {
  if (!fs.existsSync(file)) return null;
  const mtime = fs.statSync(file).mtimeMs;
  let rawIndex = rawIndexes.get(file);
  if (!rawIndex || rawIndex.mtime !== mtime) {
    const buf = fs.readFileSync(file);
    const at = new Map<number, [number, number]>();
    for (let pos = 0; pos < buf.length;) {
      let end = buf.indexOf(10, pos);
      if (end < 0) end = buf.length;
      const m = /^\{"id":(\d+)/.exec(buf.toString('latin1', pos, Math.min(pos + 24, end)));
      if (m) at.set(Number(m[1]), [pos, end - pos]);
      pos = end + 1;
    }
    rawIndex = { mtime, at };
    rawIndexes.set(file, rawIndex);
  }
  const loc = rawIndex.at.get(id);
  if (!loc) return null;
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(loc[1]);
    fs.readSync(fd, b, 0, loc[1], loc[0]);
    return JSON.parse(b.toString('utf8'));
  } finally { fs.closeSync(fd); }
}

const truthy = (v: string | undefined) => v !== undefined && /^(true|1)$/i.test(v.trim());

export function getItem(id: number) {
  const { byId, items, labels } = load();
  const it = byId.get(id);
  if (!it) return null;
  const raw = rawLine(id);
  const f: Record<string, string> = raw?.f ?? {};
  // manastone sockets and max enchant, same rules as the mail / shop editor (items.ts)
  const info = { quality: it.q, item_type: f.item_type ?? 'normal', slot_bonus: Number(f.option_slot_bonus ?? 0) || 0,
    no_enchant: truthy(f.no_enchant) } as ItemInfo;
  const gear = isGear(id);
  const slots = baseSlots(id, info);
  // bonus stats in file order, with labels
  const bonus = Object.keys(f).filter((k) => /^bonus_attr\d+$/.test(k)).sort((a, b) => Number(a.slice(10)) - Number(b.slice(10)))
    .map((k) => /^\s*([A-Za-z_]+)\s+(-?[\d.]+%?)/.exec(f[k])).filter(Boolean)
    .map((m) => { const key = m![1].toLowerCase().replace('magical_resist', 'magicalresist'); return { key, label: labels[key] ?? m![1], value: m![2] }; });
  // names of items referenced by the record (currencies, trade-ins)
  const byKey = new Map(items.map((x) => [x.k.toLowerCase(), x]));
  const ref = (name: string | undefined) => {
    if (!name) return null;
    const r = byKey.get(name.toLowerCase());
    return { k: name, id: r?.id ?? 0, zh: r?.zh ?? '', en: r?.en ?? '', q: r?.q ?? '', ic: r?.ic };
  };
  return {
    ...it, statLabels: Object.fromEntries(Object.keys(it.st ?? {}).map((k) => [k, labels[k] ?? k])),
    f, desc: raw?.dl ?? null, bonus,
    gear, slots: { base: slots, extra: gear ? Math.max(0, Math.min(info.slot_bonus, 6 - slots)) : 0 },
    maxEnchant: maxEnchant(id, info),
    refs: { abyssItem: ref(f.abyss_item), extraCurrency: ref(f.extra_currency_item), tradeIn: ref(f.trade_in_item) },
    groups: itemGroups(id),
  };
}

// ---- 掉落组: data/db_dropgroups.json, built by tools/build_db_dropgroups.py (CommonDropItems.xml + npcs.xml) ----
// weight is per roll in 1/10,000,000 at adjustment 100; a referencing NPC scales it by its common_drop_adjustment / 100.
type DropGroup = { id: number; name: string; items: Array<[number | string, number]>; users: number; npcs: Array<[number, number]> };
// npc id -> [internal name, Chinese, English, level]
type NpcInfo = [string, string, string, number];
const GROUPS_FILE = path.join(ROOT, 'data', 'db_dropgroups.json');
let groupCache: { mtime: number; groups: DropGroup[]; byId: Map<number, DropGroup>; npcs: Record<string, NpcInfo> } | null = null;

function loadGroups() {
  if (!fs.existsSync(GROUPS_FILE)) {
    throw new LError('没有掉落组数据 data/db_dropgroups.json：先用 tools/build_db_dropgroups.py 生成（见 README）',
      'No drop-group data data/db_dropgroups.json: generate it with tools/build_db_dropgroups.py (see README)');
  }
  const mtime = fs.statSync(GROUPS_FILE).mtimeMs;
  if (!groupCache || groupCache.mtime !== mtime) {
    const raw = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    const groups: DropGroup[] = raw.groups ?? [];
    groupCache = { mtime, groups, byId: new Map(groups.map((g) => [g.id, g])), npcs: raw.npcs ?? {} };
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

// item id -> [group id, weight] for every drop group holding it; rebuilt when the group file is reloaded
let groupsByItem: { src: object; map: Map<number, Array<[number, number]>> } | null = null;

// Drop groups containing an item (null when there is no group data). best = the highest per-kill chance of this
// item among the NPCs referencing the group (weight x their biggest adjustment / 100), in 1/10,000,000.
function itemGroups(id: number) {
  if (!fs.existsSync(GROUPS_FILE)) return null;
  const gc = loadGroups();
  if (!groupsByItem || groupsByItem.src !== gc) {
    const map = new Map<number, Array<[number, number]>>();
    for (const g of gc.groups) for (const [iid, w] of g.items) {
      if (typeof iid !== 'number') continue;
      let a = map.get(iid);
      if (!a) map.set(iid, a = []);
      a.push([g.id, w]);
    }
    groupsByItem = { src: gc, map };
  }
  return (groupsByItem.map.get(id) ?? []).map(([gid, w]) => {
    const g = gc.byId.get(gid)!;
    const maxAdj = g.npcs?.[0]?.[1] ?? 0;
    return { id: gid, name: g.name, weight: w, total: g.items.reduce((n, [, x]) => n + x, 0), users: g.users,
      best: Math.min(w * maxAdj / 100, 1e7) };
  });
}

export function getGroup(id: number) {
  const { byId: groupsById, npcs } = loadGroups();
  const g = groupsById.get(id);
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
    // referencing NPCs; chance = this group's total per kill for that NPC (capped at 100%), in 1/10,000,000
    npcs: (g.npcs ?? []).map(([nid, adj]) => {
      const n = npcs[String(nid)];
      return { id: nid, k: n?.[0] ?? '', zh: n?.[1] ?? '', en: n?.[2] ?? '', lv: n?.[3] ?? 0, adj,
        chance: Math.min(total * adj / 100, 1e7) };
    }),
  };
}

// ---- NPC: data/db_npcs.json, built by tools/build_db_npcs.py (npcs.xml + spawns + drops + client strings) ----
export type DbNpc = {
  id: number; k: string; zh: string; en: string; lv: number;
  g: number;                        // hpgauge_level: 1-5 normal, 10-14 elite, 20-22 hero, 26-27 legend
  hp: number;
  c: '' | 'light' | 'dark' | 'monster' | 'chief' | 'boss' | 'instance';   // instance: only spawned in instances
  race: string; tribe: string;
  t?: [string, string];             // title (Chinese, English)
  maps?: string[];                  // world.xml folders it is spawned in, most spawns first
  ai?: 1;                           // spawned by another NPC's AI pattern
  h?: 1;                            // no display name (triggers, invisible helpers): left out of the lists
};
const NPCS_FILE = path.join(ROOT, 'data', 'db_npcs.json');
// 副本 submenu entry: instance versions sharing a display name, with the level spread of their NPCs
type Instance = { key: string; zh: string; en: string; maps: string[]; n: number; lvMin: number; lvMax: number; lv: number };
let npcCache: { mtime: number; npcs: DbNpc[]; byId: Map<number, DbNpc>; maps: Record<string, [string, string]>;
  instances: Instance[] } | null = null;

function loadNpcs() {
  if (!fs.existsSync(NPCS_FILE)) {
    throw new LError('没有 NPC 数据 data/db_npcs.json：先用 tools/build_db_npcs.py 生成（见 README）',
      'No NPC data data/db_npcs.json: generate it with tools/build_db_npcs.py (see README)');
  }
  const mtime = fs.statSync(NPCS_FILE).mtimeMs;
  if (!npcCache || npcCache.mtime !== mtime) {
    const raw = JSON.parse(fs.readFileSync(NPCS_FILE, 'utf8'));
    const npcs: DbNpc[] = raw.npcs ?? [];
    npcCache = { mtime, npcs, byId: new Map(npcs.map((n) => [n.id, n])), maps: raw.maps ?? {}, instances: raw.instances ?? [] };
  }
  return npcCache;
}

export const npcGrade = (g: number) => (g >= 26 ? 'legend' : g >= 20 ? 'hero' : g >= 10 ? 'elite' : g >= 1 ? 'normal' : '');

export type NpcQuery = {
  cat: string; map?: string;        // cat 'instance': every listed NPC spawned in that instance (or in any instance) lvMin?: number; lvMax?: number; grades: string[]; search: string; page: number; size: number;
  sort?: 'id' | 'lv'; desc?: boolean;
};

export function queryNpcs(q: NpcQuery) {
  const { npcs, maps, instances } = loadNpcs();
  const s = q.search.trim().toLowerCase();
  // 副本 lists by map, not by category: an instance holds its own monsters, field mobs also spawned there and
  // the factions' NPCs (enemies in PvP instances)
  let inCat = (n: DbNpc) => !q.cat || n.c === q.cat;
  if (q.cat === 'instance') {
    const folders = new Set((q.map ? instances.filter((i) => i.key === q.map) : instances).flatMap((i) => i.maps));
    inCat = (n) => n.c !== '' && !!n.maps?.some((w) => folders.has(w));
  }
  const rows = npcs.filter((n) => !n.h && inCat(n)
    && (q.lvMin === undefined || n.lv >= q.lvMin) && (q.lvMax === undefined || n.lv <= q.lvMax)
    && (!q.grades.length || q.grades.includes(npcGrade(n.g)))
    && (!s || String(n.id).startsWith(s) || n.zh.toLowerCase().includes(s) || n.en.toLowerCase().includes(s)
      || n.k.toLowerCase().includes(s) || (n.t ? n.t.some((x) => x.toLowerCase().includes(s)) : false)));
  const dir = q.desc ? -1 : 1;
  if (q.sort === 'lv') rows.sort((a, b) => (a.lv - b.lv) * dir || a.id - b.id);
  else if (q.desc) rows.sort((a, b) => b.id - a.id);
  const size = Math.min(Math.max(q.size, 1), 100);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(Math.max(q.page, 1), pages);
  return {
    total: rows.length, page, pages, size, sort: q.sort === 'lv' ? 'lv' : 'id', desc: !!q.desc,
    rows: rows.slice((page - 1) * size, page * size).map((n) => ({ id: n.id, k: n.k, zh: n.zh, en: n.en, lv: n.lv,
      grade: npcGrade(n.g), g: n.g, c: n.c, t: n.t, ai: n.ai,
      maps: n.maps?.slice(0, 3).map((w) => ({ w, zh: maps[w]?.[0] || w, en: maps[w]?.[1] || w })), more: Math.max(0, (n.maps?.length ?? 0) - 3) })),
  };
}

export function npcInstances() {
  return loadNpcs().instances.map(({ key, zh, en, n, lvMin, lvMax, lv }) => ({ key, zh, en, n, lvMin, lvMax, lv }));
}

// internal item name / group name -> record, rebuilt when the source file is reloaded
let itemsByKey: { src: object; map: Map<string, DbItem> } | null = null;
let groupsByName: { src: object; map: Map<string, DropGroup> } | null = null;

export function getNpc(id: number) {
  const { byId, maps } = loadNpcs();
  const n = byId.get(id);
  if (!n) return null;
  // every npcs.xml field ([path, value] in file order) and the drop lists, from db_npcs_raw.ndjson
  const raw = rawLine(id, path.join(ROOT, 'data', 'db_npcs_raw.ndjson'));
  const ic = load();
  if (!itemsByKey || itemsByKey.src !== ic) itemsByKey = { src: ic, map: new Map(ic.items.map((x) => [x.k.toLowerCase(), x])) };
  const item = (k: string) => {
    const it = itemsByKey!.map.get(k.toLowerCase());
    return { k, id: it?.id ?? 0, zh: it?.zh ?? '', en: it?.en ?? '', lv: it?.lv ?? 0, q: it?.q ?? '', ic: it?.ic };
  };
  const gc = fs.existsSync(GROUPS_FILE) ? loadGroups() : null;
  if (gc && (!groupsByName || groupsByName.src !== gc)) groupsByName = { src: gc, map: new Map(gc.groups.map((g) => [g.name.toLowerCase(), g])) };
  return {
    ...n, grade: npcGrade(n.g), mapNames: Object.fromEntries((n.maps ?? []).map((w) => [w, maps[w] ?? [w, w]])),
    f: raw?.f ?? [], cash: raw?.cash ?? [0, 0, 0],
    // direct items: each rolled on its own, chance min(prob, 70%) per kill at drop rate 100
    drops: (raw?.d ?? []).map(([k, count, prob, idx]: [string, number, number, string]) =>
      ({ ...item(k), count, prob, chance: Math.min(prob, 7e6), idx })),
    // common groups: one roll each, at most one item; chance = group total x adjustment / 100 (adjustment <= 0: not rolled)
    groups: (raw?.cd ?? []).map(([name, adj, idx]: [string, number, string]) => {
      const g = groupsByName?.map.get(name.toLowerCase());
      const total = g ? g.items.reduce((s, [, w]) => s + w, 0) : 0;
      return { id: g?.id ?? 0, name, adj, idx, items: g?.items.length ?? 0, chance: adj > 0 ? Math.min(total * adj / 100, 1e7) : 0 };
    }),
  };
}
