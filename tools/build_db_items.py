"""Build data/db_items.json (the 静态数据库 item table) from your own server and client files:
the server's items.xml plus the client's Chinese and/or English string tables.

usage:
  py tools/build_db_items.py --items <server items.xml> [--zh <Chinese strings>] [--en <English strings>] [--out <file>]

Arguments are the same as tools/build_items_cache.py (see there), plus --client <client>/Data/Items/Items.pak (or its
client_items.xml), which gives each item its icon name ("ic"; the PNGs come from tools/build_db_icons.py) and
its long description. Every item's full field list also goes to data/db_items_raw.ndjson for the detail page. Each item gets its menu categories (the route keys
used by public/db.html, e.g. armor/chain/chest), level, quality, race and bonus stats. Restart the admin after
rebuilding the file.

Categories follow the official item-id ranges (1000xxxxx swords, 1105xxxxx chain torsos, 1670xxxxx manastones ...);
stigmas and skill books are filed under every class that may use them. NPC-only and test items are kept but marked
hidden ("h": 1), so the page leaves them out unless asked.
"""
import argparse, html, json, os, re, sys, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_items_cache import decode, strings

HERE = os.path.dirname(os.path.abspath(__file__))
DB_VER = 1

WEAPON = {'1000': 'sword', '1001': 'mace', '1002': 'dagger', '1005': 'orb', '1006': 'grimoire', '1009': '2h_sword',
          '1013': 'polearm', '1015': 'staff', '1017': 'bow'}
ARMOR = {'clothes': 'cloth', 'robe': 'robe', 'leather': 'leather', 'chain': 'chain', 'plate': 'plate'}
PART = {'torso': 'chest', 'glove': 'hands', 'shoulder': 'shoulders', 'leg': 'legs', 'foot': 'feet'}
ACCESSORY = {'125': 'headgear', '1200': 'earring', '1210': 'necklace', '1220': 'ring', '1230': 'belt'}
CLASSES = ['fighter', 'knight', 'assassin', 'ranger', 'wizard', 'elementalist', 'priest', 'chanter']
RECIPE = {'ws': 'weaponsmith', 'as': 'armorsmith', 'ta': 'tailoring', 'ha': 'handiwork', 'al': 'alchemy',
          'co': 'cooking', 'cv': 'convert'}
# consumable id prefixes (longest match wins)
CONSUMABLE = {'1600': 'food', '1610': 'magical', '1620': 'potion', '1693': 'potion', '1640': 'magical',
              '1650': 'mod/enchant', '1660': 'mod/enchant', '1661': 'mod/enchant', '1670': 'mod/option',
              '1680': 'mod/proc', '1691': 'mod/dye', '1692': 'mod/dye', '1681': 'mod/misc', '1682': 'mod/misc',
              '1683': 'mod/misc'}

# bonus_attr stat keys (lower case) -> label shown in the filter; anything else keeps its key
STAT_LABEL = {
    'phyattack': '物理攻击力', 'magicalattack': '魔法攻击力', 'magicalskillboost': '魔法增幅力', 'hitaccuracy': '命中',
    'magicalhitaccuracy': '魔法命中', 'critical': '物理致命一击', 'magicalcritical': '魔法致命一击', 'attackdelay': '攻击速度',
    'boostcastingtime': '施法速度', 'maxhp': '最大生命力', 'maxmp': '最大精神力', 'maxfp': '最大飞行时间',
    'physicaldefend': '物理防御力', 'magicalresist': '魔法抵抗', 'magical_resist': '魔法抵抗', 'dodge': '回避', 'block': '格挡',
    'parry': '武器防御', 'concentration': '集中', 'healskillboost': '治愈量增加', 'speed': '移动速度', 'flyspeed': '飞行速度',
    'boosthate': '敌对值增加率', 'elementaldefendfire': '火属性防御', 'elementaldefendwater': '水属性防御',
    'elementaldefendearth': '地属性防御', 'elementaldefendair': '风属性防御', 'arstun': '眩晕抵抗', 'arsilence': '沉默抵抗',
    'arparalyze': '麻痹抵抗', 'arroot': '束缚抵抗', 'arsleep': '睡眠抵抗', 'arsnare': '减速抵抗', 'arslow': '迟缓抵抗',
    'arfear': '恐惧抵抗', 'archarm': '魅惑抵抗', 'arblind': '失明抵抗', 'arpoison': '中毒抵抗', 'arbleed': '出血抵抗',
    'arcurse': '诅咒抵抗', 'ardisease': '疾病抵抗', 'arconfuse': '混乱抵抗', 'arstumble': '摔倒抵抗', 'arstagger': '击退抵抗',
    'aropenareial': '空中束缚抵抗', 'arspin': '旋转抵抗', 'arperification': '石化抵抗',
    'pvpattackratio': '对人攻击力', 'pvpdefendratio': '对人防御力', 'paralyze_arp': '麻痹贯穿', 'silence_arp': '沉默贯穿',
    'physicalcriticalreducerate': '物理致命一击抵抗', 'magicalcriticalreducerate': '魔法致命一击抵抗',
    'physicalcriticaldamagereduce': '物理致命伤害减少', 'magicalcriticaldamagereduce': '魔法致命伤害减少',
}


def categories(f):
    """Menu route keys (without the leading 'item/') this item belongs to."""
    iid, slot = f['id'], f.get('equipment_slots', 'none')
    p3, p4, p5, p6 = iid[:3], iid[:4], iid[:5], iid[:6]
    if p4 in WEAPON:
        return ['weapon/' + WEAPON[p4]]
    if p4 == '1150':
        return ['armor/shield']
    if p3 in ('110', '111', '112', '113', '114') and f.get('armor_type') in ARMOR and slot in PART:
        return [f'armor/{ARMOR[f["armor_type"]]}/{PART[slot]}']
    if p3 == '125':
        return ['accessory/headgear']
    if p4 in ACCESSORY:
        return ['accessory/' + ACCESSORY[p4]]
    if p4 == '1870':
        return ['wing']
    if p4 in ('1400', '1695'):
        kind = 'stigma' if p4 == '1400' else 'book'
        cls = [c for c in CLASSES if f.get(c, '0') not in ('', '0')]
        return [f'skillrelated/{kind}/{c}' for c in cls] or [f'skillrelated/{kind}']
    if p4 == '1520':
        sub = int(iid[4:6])            # 152 0xx : 00-09 gathered, 10-19 dropped, 20+ parts
        return ['making/material/' + ('gather' if sub < 10 else 'drop' if sub < 20 else 'part')]
    if p4 == '1522':
        name = f.get('name', '').lower()
        if re.match(r'item_rd?_[a-z]+_q', name):     # work-order recipes (制作委托), e.g. item_r_ws_q5000
            return ['making/recipes/order']
        m = re.match(r'rec_[a-z]+_([a-z]+)_', name)
        return ['making/recipes/' + RECIPE[m.group(1)]] if m and m.group(1) in RECIPE else ['making/recipes']
    if p4 == '1694':                                  # hardener, glue, lubricant ... sold for crafting
        return ['making/material/part']
    for k in sorted(CONSUMABLE, key=len, reverse=True):
        if iid.startswith(k):
            return ['consumable/' + CONSUMABLE[k]]
    return ['consumable/misc']


def parse_stats(f):
    out = {}
    for k, v in f.items():
        if not re.fullmatch(r'bonus_attr\d+', k) or not v.strip():
            continue
        m = re.match(r'\s*([A-Za-z_]+)\s+(-?[\d.]+)(%?)', v)
        if not m:
            continue
        key = m.group(1).lower().replace('magical_resist', 'magicalresist')
        val = float(m.group(2))
        out[key] = (str(int(val)) if val == int(val) else str(val)) + m.group(3)
    return out


def client_icons(src):
    """item id -> lower-case icon name, from the client's client_items.xml (file, folder, or ZIP-format Items.pak)."""
    if not src:
        return {}
    if os.path.isdir(src):
        src = os.path.join(src, 'client_items.xml')
    if zipfile.is_zipfile(src):
        with zipfile.ZipFile(src) as z:
            n = next((x for x in z.namelist() if x.lower().endswith('client_items.xml')), None)
            if not n: sys.exit(f'{src}: no client_items.xml inside')
            text = decode(z.read(n))
    else:
        text = decode(open(src, 'rb').read())
    out = {}                                  # id -> (icon name, desc_long string key)
    for blk in re.findall(r'<client_item>(.*?)</client_item>', text, re.S):
        i = re.search(r'<id>(\d+)</id>', blk)
        if not i: continue
        ic, dl = re.search(r'<icon_name>([^<]+)</icon_name>', blk), re.search(r'<desc_long>([^<]+)</desc_long>', blk)
        out[i.group(1)] = (ic.group(1).strip().lower() if ic else '', dl.group(1).strip().upper() if dl else '')
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--items', required=True)
    ap.add_argument('--zh')
    ap.add_argument('--en')
    ap.add_argument('--client', help='client Data/Items/Items.pak (ZIP format) or client_items.xml, for icon names')
    ap.add_argument('--out', default=os.path.join(HERE, '..', 'data', 'db_items.json'))
    ap.add_argument('--raw-out', default=os.path.join(HERE, '..', 'data', 'db_items_raw.ndjson'),
                    help="every item's full field list, one JSON object per line (the detail page reads it by id)")
    a = ap.parse_args()
    if not a.zh and not a.en: ap.error('give --zh and/or --en')
    zh, en = strings(a.zh), strings(a.en)
    icons = client_icons(a.client)
    rows, raws = [], []
    for x in re.findall(r'<item>(.*?)</item>', decode(open(a.items, 'rb').read()), re.S):
        f = {k: html.unescape(v) for k, v in re.findall(r'<(\w+)>([^<]*)</\1>', x)}
        if 'id' not in f: continue
        key, name = f.get('desc', '').upper(), f.get('name', '')
        rp = f.get('race_permitted', 'pc_light pc_dark')
        race = 2 if ('pc_light' in rp and 'pc_dark' in rp) else 0 if 'pc_light' in rp else 1 if 'pc_dark' in rp else 2
        r = dict(id=int(f['id']), k=name, zh=zh.get(key, ''), en=en.get(key, ''),
                 lv=int(f.get('level', '0') or 0), q=f.get('quality', 'common').lower(), race=race, c=categories(f))
        ic, dl = icons.get(f['id'], ('', ''))
        if ic: r['ic'] = ic
        raw = {'id': r['id'], 'f': f}
        if dl and (zh.get(dl) or en.get(dl)): raw['dl'] = {'zh': zh.get(dl, ''), 'en': en.get(dl, '')}
        raws.append(raw)
        st = parse_stats(f)
        if st: r['st'] = st
        if re.match(r'(npc_|test)', name.lower()) or '_test' in name.lower(): r['h'] = 1
        rows.append(r)
    if not rows: sys.exit(f'{a.items}: no <item> entries found')
    rows.sort(key=lambda r: r['id'])
    out = dict(_ver=DB_VER, stats=STAT_LABEL, items=rows)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    tmp = a.out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fp: json.dump(out, fp, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, a.out)
    raws.sort(key=lambda x: x['id'])
    with open(a.raw_out + '.tmp', 'w', encoding='utf-8', newline='\n') as fp:
        for x in raws: fp.write(json.dumps(x, ensure_ascii=False, separators=(',', ':')) + '\n')
    os.replace(a.raw_out + '.tmp', a.raw_out)
    from collections import Counter
    cats = Counter(c.split('/')[0] for r in rows for c in r['c'])
    print(f'{len(rows)} items -> {os.path.abspath(a.out)}; {sum(1 for r in rows if r["zh"])} Chinese names; '
          f'{sum(1 for r in rows if r.get("ic"))} icons; '
          f'{sum(1 for r in rows if r.get("h"))} hidden (npc/test); by top category: {dict(cats)}')


if __name__ == '__main__':
    main()
