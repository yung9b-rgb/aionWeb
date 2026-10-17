"""Build data/items_cache.json (item names and attributes for the admin) from the server's items.xml and the
client's string tables: Chinese names from the Chinese strings, English names from the English strings.

usage: py tools/build_items_cache.py --items <server items.xml> --zh <dir of Chinese client strings>
                                     --en <dir of English client strings> [--out data/items_cache.json]

The string directories hold the client's decoded strings/*.xml (UTF-16 or UTF-8 text XML). The output keeps the
format the admin and the older Tools/gm-mail/gm_mail.py use (_ver 3), plus an "en" field per item.
"""
import argparse, glob, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_VER = 3


def load(path):
    b = open(path, 'rb').read()
    return b.decode('utf-16') if b[:2] in (b'\xff\xfe', b'\xfe\xff') else b.decode('utf-8', 'replace')


def strings(folder):
    out = {}
    for p in glob.glob(os.path.join(folder, '*.xml')):
        for n, b in re.findall(r'<name>([^<]*)</name>\s*<body>([^<]*)</body>', load(p)):
            out[n.upper()] = b
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--items', required=True, help='server items.xml (e.g. AionMaps/Map/XML/L10N/items.xml)')
    ap.add_argument('--zh', required=True, help='folder with the Chinese client strings/*.xml')
    ap.add_argument('--en', required=True, help='folder with the English client strings/*.xml')
    ap.add_argument('--out', default=os.path.join(HERE, '..', 'data', 'items_cache.json'))
    a = ap.parse_args()
    zh, en = strings(a.zh), strings(a.en)
    if not zh or not en: sys.exit('no strings found: check --zh / --en')
    db = {}
    for x in re.findall(r'<item>(.*?)</item>', load(a.items), re.S):
        f = dict(re.findall(r'<(\w+)>([^<]*)</\1>', x))
        if 'id' not in f: continue
        key = f.get('desc', '').upper()
        db[f['id']] = dict(name=f.get('name', ''), zh=zh.get(key, ''),
                           max_stack=int(f.get('max_stack_count', '1') or 1), quality=f.get('quality', ''),
                           level=f.get('level', ''), tradable=f.get('can_exchange', 'TRUE').upper() == 'TRUE',
                           item_type=f.get('item_type', 'normal'), slot_bonus=int(f.get('option_slot_bonus', '0') or 0),
                           equip=f.get('equipment_slots', 'none') not in ('', 'none'),
                           no_enchant=f.get('no_enchant', 'FALSE').upper() == 'TRUE',
                           en=en.get(key, ''))
    db['_ver'] = CACHE_VER
    tmp = a.out + '.tmp'
    json.dump(db, open(tmp, 'w', encoding='utf-8'), ensure_ascii=False)
    os.replace(tmp, a.out)
    n = len(db) - 1
    print(f'{n} items -> {os.path.abspath(a.out)} ({sum(1 for k, v in db.items() if k != "_ver" and v["zh"])} zh names, '
          f'{sum(1 for k, v in db.items() if k != "_ver" and v["en"])} en names)')


if __name__ == '__main__':
    main()
