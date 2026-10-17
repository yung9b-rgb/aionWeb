"""Build data/items_cache.json (item names and attributes for the admin) from your own server and client files:
the server's items.xml plus the client's Chinese and/or English string tables.

usage:
  py tools/build_items_cache.py --items <server items.xml> [--zh <Chinese strings>] [--en <English strings>] [--out <file>]

  --items  the server's item templates, e.g. <server>/Map/XML/L10N/items.xml
  --zh/--en  the client's strings for that language, either
             - a folder holding strings/*.xml (or the *.xml files themselves), or
             - a .zip / .pak that is a standard ZIP archive and contains strings/*.xml
           At least one of them is needed; an item without a name in a language falls back to its internal name.

The string files may be text XML (UTF-8 or UTF-16) or the client's binary XML. The language paks shipped with the
client (l10n/<lang>/data/Data.pak) are not standard ZIP files: convert or unpack one with a pak tool first.

The output keeps the format the admin uses (_ver 3) and is read at start; restart the admin after rebuilding it.
"""
import argparse, glob, html, io, json, os, re, sys, zipfile
from xml.sax.saxutils import escape, quoteattr

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_VER = 3


def bxml_to_text(b):
    """Decode the client's binary XML (first byte 0x80) to text XML."""
    pos = 1
    def rd():
        nonlocal pos
        v = s = 0
        while True:
            c = b[pos]; pos += 1; v |= (c & 0x7F) << s; s += 7
            if not c & 0x80: return v
    n = rd(); st = b[pos:pos + n]; pos += n; cache = {}
    def S(i):
        r = cache.get(i)
        if r is None:
            o = e = i * 2
            while st[e:e + 2] != b'\0\0': e += 2
            r = cache[i] = st[o:e].decode('utf-16le')
        return r
    out = []
    def node():
        nonlocal pos
        name = S(rd()); fl = b[pos]; pos += 1
        val = S(rd()) if fl & 1 else ''
        attrs = ''.join(f' {S(rd())}={quoteattr(S(rd()))}' for _ in range(rd())) if fl & 2 else ''
        out.append(f'<{name}{attrs}>{escape(val)}')
        for _ in range(rd() if fl & 4 else 0): node()
        out.append(f'</{name}>')
    node()
    return ''.join(out)


def decode(b):
    if b[:1] == b'\x80': return bxml_to_text(b)
    if b[:2] in (b'\xff\xfe', b'\xfe\xff'): return b.decode('utf-16')
    return b.decode('utf-8-sig', 'replace')


def string_files(src):
    """Yield the contents of every strings XML file under a folder or inside a ZIP-format .zip/.pak."""
    if os.path.isdir(src):
        sub = os.path.join(src, 'strings')
        folder = sub if os.path.isdir(sub) else src
        for p in sorted(glob.glob(os.path.join(folder, '*.xml'))):
            yield open(p, 'rb').read()
    elif os.path.isfile(src):
        if not zipfile.is_zipfile(src):
            sys.exit(f'{src}: not a standard ZIP archive. The client\'s own .pak files must be converted or unpacked '
                     f'with a pak tool first; then pass the resulting .zip or folder.')
        with zipfile.ZipFile(src) as z:
            for n in z.namelist():
                if re.search(r'(^|/)strings/[^/]+\.xml$', n.replace('\\', '/'), re.I):
                    yield z.read(n)
    else:
        sys.exit(f'{src}: no such file or folder')


def strings(src):
    out = {}
    if not src: return out
    for b in string_files(src):
        for n, body in re.findall(r'<name>([^<]*)</name>\s*<body>([^<]*)</body>', decode(b)):
            out[n.strip().upper()] = html.unescape(body)
    if not out: sys.exit(f'{src}: no strings found (expected strings/*.xml with <name>/<body> entries)')
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--items', required=True, help="server items.xml (e.g. <server>/Map/XML/L10N/items.xml)")
    ap.add_argument('--zh', help='Chinese client strings: folder, .zip or ZIP-format .pak')
    ap.add_argument('--en', help='English client strings: folder, .zip or ZIP-format .pak')
    ap.add_argument('--out', default=os.path.join(HERE, '..', 'data', 'items_cache.json'))
    a = ap.parse_args()
    if not a.zh and not a.en: ap.error('give --zh and/or --en')
    zh, en = strings(a.zh), strings(a.en)
    db = {}
    for x in re.findall(r'<item>(.*?)</item>', decode(open(a.items, 'rb').read()), re.S):
        f = {k: html.unescape(v) for k, v in re.findall(r'<(\w+)>([^<]*)</\1>', x)}
        if 'id' not in f: continue
        key = f.get('desc', '').upper()
        db[f['id']] = dict(name=f.get('name', ''), zh=zh.get(key, ''),
                           max_stack=int(f.get('max_stack_count', '1') or 1), quality=f.get('quality', ''),
                           level=f.get('level', ''), tradable=f.get('can_exchange', 'TRUE').upper() == 'TRUE',
                           item_type=f.get('item_type', 'normal'), slot_bonus=int(f.get('option_slot_bonus', '0') or 0),
                           equip=f.get('equipment_slots', 'none') not in ('', 'none'),
                           no_enchant=f.get('no_enchant', 'FALSE').upper() == 'TRUE',
                           en=en.get(key, ''))
    if not db: sys.exit(f'{a.items}: no <item> entries found')
    db['_ver'] = CACHE_VER
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    tmp = a.out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fp: json.dump(db, fp, ensure_ascii=False)
    os.replace(tmp, a.out)
    items = [v for k, v in db.items() if k != '_ver']
    print(f'{len(items)} items -> {os.path.abspath(a.out)} ({sum(1 for v in items if v["zh"])} Chinese names, '
          f'{sum(1 for v in items if v["en"])} English names)')


if __name__ == '__main__':
    main()
