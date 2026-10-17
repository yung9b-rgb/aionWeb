// Item names/attributes from the cache built by Tools/gm-mail/gm_mail.py (items.xml + client strings).
import fs from 'node:fs';

export type ItemInfo = {
  name: string; zh: string; max_stack: number; quality: string; level: string; tradable: boolean;
  item_type: string; slot_bonus: number; equip: boolean; no_enchant: boolean;
  en?: string;   // English name from the client's English strings (added by Tools/add_item_en.py)
};

let items: Map<number, ItemInfo> | null = null;

export function loadItems(path: string): Map<number, ItemInfo> {
  if (!items) {
    const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
    items = new Map();
    for (const [k, v] of Object.entries(raw)) if (/^\d+$/.test(k)) items.set(Number(k), v as ItemInfo);
  }
  return items;
}

export function itemLabel(db: Map<number, ItemInfo>, id: number, lang: 'zh' | 'en' = 'zh'): string {
  if (id === 0) return lang === 'en' ? '(system placeholder, created with the character)' : '（系统占位，建角时自动生成）';
  const it = db.get(id);
  return it ? itemName(it, lang) : `#${id}`;
}

export function itemName(it: ItemInfo, lang: 'zh' | 'en' = 'zh'): string {
  return lang === 'en' ? (it.en || it.name) : (it.zh || it.name);
}

export function searchItems(db: Map<number, ItemInfo>, q: string, limit = 30) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const out: Array<{ id: number; gear: boolean; baseSlots: number; maxExtraSlots: number; maxEnchant: number } & ItemInfo> = [];
  for (const [id, it] of db) {
    if (String(id).startsWith(s) || it.zh.toLowerCase().includes(s) || it.name.toLowerCase().includes(s) || (it.en ?? '').toLowerCase().includes(s)) {
      const gear = isGear(id);
      const base = baseSlots(id, it);
      // extra sockets allowed = template option_slot_bonus, but never past 6 in total
      out.push({ id, ...it, gear, baseSlots: base, maxExtraSlots: gear ? Math.max(0, Math.min(it.slot_bonus, 6 - base)) : 0,
        maxEnchant: maxEnchant(id, it) });
      if (out.length >= limit) break;
    }
  }
  return out;
}

// Manastone sockets: base count by quality x item_type (Server64 g_itemOptionMaxCountTbl), max total 6.
const BASE_SLOTS: Record<string, number[]> = {
  common: [1, 0, 0, 1], rare: [2, 4, 3, 2], legend: [3, 5, 4, 3], unique: [4, 6, 5, 4], epic: [5, 6, 6, 5], mythic: [6, 6, 6, 6],
};
const TYPE_COL: Record<string, number> = { normal: 0, abyss: 1, draconic: 2, devanion: 3 };

// Max enchant level by quality: Server64 GetItemMaxEnchantCount -> g_itemEnchantMaxCountTbl[quality][itemType]
// (same for all 4 item types): junk 0, common/rare/legend 10, unique/epic/mythic 15.
const MAX_ENCHANT: Record<string, number> = { junk: 0, common: 10, rare: 10, legend: 10, unique: 15, epic: 15, mythic: 15 };

export function maxEnchant(id: number, it: ItemInfo): number {
  if (!isGear(id) || it.no_enchant) return 0;
  return MAX_ENCHANT[it.quality.toLowerCase()] ?? 0;
}

export function isGear(id: number): boolean {
  return (id >= 100000000 && id < 103100000) || (id >= 110000000 && id < 115100000);
}

export function baseSlots(id: number, it: ItemInfo): number {
  if (!isGear(id)) return 0;
  return (BASE_SLOTS[it.quality.toLowerCase()] ?? [0, 0, 0, 0])[TYPE_COL[it.item_type] ?? 0];
}
