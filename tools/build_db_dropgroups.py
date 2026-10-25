"""Build data/db_dropgroups.json (the 掉落组 page of 静态数据库) from your own server files.

usage:
  py tools/build_db_dropgroups.py --common <server>/Map/XML/CommonDropItems.xml --npcs <server>/Map/XML/npcs.xml
                                  [--zh <Chinese client strings>] [--en <English client strings>]

Run tools/build_db_items.py first: item names in the drop groups are resolved to ids through data/db_items.json.

Each group keeps its items with their weight (prob, in 1/10,000,000 per roll) and the NPCs that reference it with a
positive common_drop_adjustment (id + adjustment). NPC names come from the client strings (--zh/--en, same forms as
tools/build_items_cache.py); without them the internal name is shown. On a kill the NPC server rolls each referenced
group once: item i drops with weight_i x adjustment / 100 / 10,000,000, and at most one item of the group drops.
"""
import argparse, json, os, re, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_items_cache import decode, strings

HERE = os.path.dirname(os.path.abspath(__file__))
DB_VER = 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--common', required=True, help='server CommonDropItems.xml')
    ap.add_argument('--npcs', required=True, help='server npcs.xml (the one the servers load)')
    ap.add_argument('--zh', help='Chinese client strings (folder, .zip or ZIP-format .pak), for NPC names')
    ap.add_argument('--en', help='English client strings, for NPC names')
    ap.add_argument('--items', default=os.path.join(HERE, '..', 'data', 'db_items.json'), help='data/db_items.json')
    ap.add_argument('--out', default=os.path.join(HERE, '..', 'data', 'db_dropgroups.json'))
    a = ap.parse_args()
    if not os.path.exists(a.items):
        sys.exit(f'{a.items}: run tools/build_db_items.py first')
    ids = {r['k'].lower(): r['id'] for r in json.load(open(a.items, encoding='utf-8'))['items']}

    groups = []
    for m in re.finditer(r'<commondrop>\s*<id>(\d+)</id>\s*<name>([^<]+)</name>(.*?)</commondrop>',
                         decode(open(a.common, 'rb').read()), re.S):
        items = []
        for name, prob in re.findall(r'<item>([^<]+)</item>\s*<prob>(\d+)</prob>', m.group(3)):
            iid = ids.get(name.strip().lower())
            items.append([iid if iid else name.strip(), int(prob)])
        groups.append(dict(id=int(m.group(1)), name=m.group(2).strip(), items=items))
    if not groups: sys.exit(f'{a.common}: no <commondrop> entries found')

    # NPCs referencing each group (positive adjustment = the group is actually rolled)
    zh, en = strings(a.zh), strings(a.en)
    users = defaultdict(dict)                # group name -> {npc id: adjustment}
    npc_info = {}                            # npc id -> [internal name, Chinese, English, level]
    npcs = decode(open(a.npcs, 'rb').read())
    for m in re.finditer(r'<id>(\d+)</id>\s*<name>([^<]*)</name>', npcs):
        start = m.end()
        end = npcs.find('<id>', start)
        blk = npcs[start:end if end > 0 else len(npcs)]
        j = blk.find('<common_drops>')
        if j < 0: continue
        nid, used = int(m.group(1)), False
        for g, adj in re.findall(r'<common_drop>([^<]+)</common_drop>\s*<common_drop_adjustment>(-?\d+)</common_drop_adjustment>', blk[j:]):
            if int(adj) > 0:
                users[g.strip().lower()][nid] = int(adj)
                used = True
        if used:
            desc = re.search(r'<desc>([^<]*)</desc>', blk[:j])
            lv = re.search(r'<level>(\d+)</level>', blk[:j])
            key = (desc.group(1) if desc else '').strip().upper()
            npc_info[nid] = [m.group(2), zh.get(key, ''), en.get(key, ''), int(lv.group(1)) if lv else 0]
    for g in groups:
        u = users.get(g['name'].lower(), {})
        g['users'] = len(u)
        g['npcs'] = sorted(([i, adj] for i, adj in u.items()), key=lambda x: (-x[1], x[0]))   # biggest adjustment first

    out = dict(_ver=DB_VER, groups=sorted(groups, key=lambda g: g['id']), npcs={str(k): v for k, v in npc_info.items()})
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    tmp = a.out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fp: json.dump(out, fp, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, a.out)
    unresolved = sum(1 for g in groups for i, _ in g['items'] if isinstance(i, str))
    print(f'{len(groups)} groups -> {os.path.abspath(a.out)}; {sum(len(g["items"]) for g in groups)} entries '
          f'({unresolved} unknown item names); {sum(1 for g in groups if g["users"])} groups used by NPCs')


if __name__ == '__main__':
    main()
