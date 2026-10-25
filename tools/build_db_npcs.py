"""Build data/db_npcs.json (the NPC pages of 静态数据库) from your own server files.

usage:
  py tools/build_db_npcs.py --npcs <server>/Map/XML/npcs.xml --common <server>/Map/XML/CommonDropItems.xml
                            --worlds <server>/Map/Worlds --ai <server>/Map/XML
                            [--zh <Chinese client strings>] [--en <English client strings>]

Run tools/build_db_items.py first: equipment drops are recognised through data/db_items.json.

Categories (the NPC submenu):
  light / dark  天族 / 魔族: race_type pc_light / gchief_light / ghenchman_light (and the _dark ones), the factions'
                own NPCs (guards, merchants, Abyss garrisons ...).
  boss  命名BOSS: named_monster = 1 with an exclusive equipment drop, either
                - an equipment item no other NPC drops (NPCs with the same display name count as one), or
                - a drop group holding equipment that no other NPC references.
  chief 头目:    the other named_monster = 1 NPCs.
  monster 怪物:  every other attackable NPC (not a faction NPC, field object or pet).
Anything else (neutral merchants, objects ...) only shows under the top-level NPC page. NPCs without a display name
(triggers, invisible helpers) are flagged hidden and left out of the lists.

"Other NPC" means NPCs that are actually spawned: named in a Map/Worlds/<map>/world.xml (the file the servers load)
or spawned by an AI pattern (<npc_nameid> in Map/XML/NpcAIPatterns*.xml). Unspawned test copies don't count.
"""
import argparse, glob, json, os, re, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_items_cache import decode, strings

HERE = os.path.dirname(os.path.abspath(__file__))
DB_VER = 1
GEAR = ('weapon/', 'armor/', 'accessory/', 'wing')


def tag(blk, k):
    m = re.search('<%s>([^<]*)</%s>' % (k, k), blk)
    return m.group(1).strip() if m else ''


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--npcs', required=True, help='server npcs.xml (the one the servers load)')
    ap.add_argument('--common', required=True, help='server CommonDropItems.xml')
    ap.add_argument('--worlds', required=True, help='server Map/Worlds folder (one sub-folder per map with world.xml)')
    ap.add_argument('--ai', required=True, help='folder with NpcAIPatterns*.xml (server Map/XML)')
    ap.add_argument('--zh', help='Chinese client strings (folder, .zip or ZIP-format .pak)')
    ap.add_argument('--en', help='English client strings')
    ap.add_argument('--items', default=os.path.join(HERE, '..', 'data', 'db_items.json'), help='data/db_items.json')
    ap.add_argument('--out', default=os.path.join(HERE, '..', 'data', 'db_npcs.json'))
    a = ap.parse_args()
    if not os.path.exists(a.items):
        sys.exit(f'{a.items}: run tools/build_db_items.py first')
    gear = {r['k'].lower() for r in json.load(open(a.items, encoding='utf-8'))['items']
            if any(c.startswith(GEAR) for c in r['c'])}
    zh, en = strings(a.zh), strings(a.en)

    # drop groups: name -> equipment items in it
    group_gear = {}
    for m in re.finditer(r'<commondrop>\s*<id>\d+</id>\s*<name>([^<]+)</name>(.*?)</commondrop>',
                         decode(open(a.common, 'rb').read()), re.S):
        group_gear[m.group(1).strip().lower()] = {x.strip().lower() for x in re.findall(r'<item>([^<]+)</item>', m.group(2))} & gear

    # spawned NPC names -> maps (world.xml) ; AI-spawned names count as spawned without a map
    maps = defaultdict(dict)
    for p in sorted(glob.glob(os.path.join(a.worlds, '*', 'world.xml'))):
        w = os.path.basename(os.path.dirname(p))
        for n in re.findall(r'<name>([^<]+)</name>', decode(open(p, 'rb').read())):
            d = maps[n.strip().lower()]
            d[w] = d.get(w, 0) + 1
    ai_spawned = set()
    for p in glob.glob(os.path.join(a.ai, 'NpcAIPatterns*.xml')):
        ai_spawned |= {n.strip().lower() for n in re.findall(r'<npc_nameid>([^<]+)</npc_nameid>', decode(open(p, 'rb').read()))}

    npcs = []
    text = decode(open(a.npcs, 'rb').read())
    for m in re.finditer(r'<npc>\s*<id>(\d+)</id>(.*?)</npc>', text, re.S):
        blk = m.group(2)
        k = tag(blk, 'name')
        desc = tag(blk, 'desc').upper()
        title = tag(blk, 'npc_title').upper()
        j = blk.find('<items_info>')
        ii = blk[j:blk.find('</items_info>', j)] if j >= 0 else ''
        direct = {x.strip().lower() for x in re.findall(r'<item>([^<]+)</item>', ii)} & gear
        common = [g.strip().lower() for g, adj in re.findall(
            r'<common_drop>([^<]+)</common_drop>\s*<common_drop_adjustment>(-?\d+)</common_drop_adjustment>', ii) if int(adj) > 0]
        npcs.append(dict(
            id=int(m.group(1)), k=k, zh=zh.get(desc, ''), en=en.get(desc, ''),
            tzh=zh.get(title, '') if title else '', ten=en.get(title, '') if title else '',
            lv=int(tag(blk, 'level') or 0), g=int(tag(blk, 'hpgauge_level') or 0), hp=int(tag(blk, 'max_hp') or 0),
            named=tag(blk, 'named_monster') == '1', race=tag(blk, 'race_type').lower(), tribe=tag(blk, 'tribe'),
            npc_type=tag(blk, 'npc_type').lower(), unatt=tag(blk, 'unattackable') == '1',
            direct=direct, common=common))

    # exclusivity among spawned NPCs; one display name = one NPC (level variants of the same mob)
    who = lambda n: (n['zh'] or n['k']).lower()
    spawned = [n for n in npcs if n['k'].lower() in maps or n['k'].lower() in ai_spawned]
    droppers, users = defaultdict(set), defaultdict(set)
    for n in spawned:
        for x in n['direct'] | {x for g in n['common'] for x in group_gear.get(g, ())}:
            droppers[x].add(who(n))
        for g in n['common']:
            users[g].add(who(n))

    def exclusive(n):
        own = n['direct'] | {x for g in n['common'] for x in group_gear.get(g, ())}
        if any(droppers[x] <= {who(n)} for x in own):
            return True
        return any(group_gear.get(g) and users[g] <= {who(n)} for g in n['common'])

    out, count = [], defaultdict(int)
    for n in npcs:
        r = n['race']
        if r.startswith(('pc_light', 'gchief_light', 'ghenchman_light')):
            cat = 'light'
        elif r.startswith(('pc_dark', 'gchief_dark', 'ghenchman_dark')):
            cat = 'dark'
        elif n['unatt'] or n['npc_type'] == 'summon_pet' or n['tribe'].lower().startswith('field_object'):
            cat = ''
        elif n['named']:
            cat = 'boss' if exclusive(n) else 'chief'
        else:
            cat = 'monster'
        count[cat or 'other'] += 1
        rec = dict(id=n['id'], k=n['k'], zh=n['zh'], en=n['en'], lv=n['lv'], g=n['g'], hp=n['hp'], c=cat,
                   race=n['race'], tribe=n['tribe'])
        if n['tzh'] or n['ten']: rec['t'] = [n['tzh'], n['ten']]
        if not (n['zh'].strip() or n['en'].strip()): rec['h'] = 1       # no display name: triggers, invisible helpers
        sp = maps.get(n['k'].lower())
        if sp: rec['maps'] = sorted(sp, key=lambda w: -sp[w])
        elif n['k'].lower() in ai_spawned: rec['ai'] = 1          # spawned by another NPC's AI
        out.append(rec)

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    tmp = a.out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fp:
        # map display names: STR_ZONE_NAME_<world folder> in the client strings
        names = {w: [zh.get('STR_ZONE_NAME_' + w.upper(), ''), en.get('STR_ZONE_NAME_' + w.upper(), '')] for w in
                 sorted({w for d in maps.values() for w in d})}
        json.dump(dict(_ver=DB_VER, npcs=out, maps=names), fp, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, a.out)
    print(f'{len(out)} NPCs -> {os.path.abspath(a.out)}; {len(spawned)} spawned; ' + ', '.join(f'{k} {v}' for k, v in sorted(count.items())))


if __name__ == '__main__':
    main()
