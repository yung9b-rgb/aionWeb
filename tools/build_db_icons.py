"""Export the item icons of your own client to public/icons/item/<icon_name>.png for the 静态数据库 page.

usage:
  py tools/build_db_icons.py --pak <client>/Data/Items/Items.pak [--out public/icons/item]

The client keeps item icons as DDS textures inside Data/Items/Items.pak. The pak must be a standard ZIP archive
(the one patched by Tools/aion-pak, or a pak converted with a pak tool) or a folder holding the *.dds files.
File names are lower-cased; db_items.json refers to them through each item's icon name (field "ic").
Needs Pillow (py -m pip install pillow). The icons are game data and are not committed (see .gitignore).
"""
import argparse, glob, io, os, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))


def dds_files(src):
    if os.path.isdir(src):
        for p in glob.glob(os.path.join(src, '**', '*.dds'), recursive=True):
            yield os.path.basename(p), open(p, 'rb').read()
    elif zipfile.is_zipfile(src):
        with zipfile.ZipFile(src) as z:
            for n in z.namelist():
                if n.lower().endswith('.dds'):
                    yield n.replace('\\', '/').rsplit('/', 1)[-1], z.read(n)
    else:
        sys.exit(f'{src}: not a folder or a standard ZIP archive (convert the client pak with a pak tool first)')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--pak', required=True)
    ap.add_argument('--out', default=os.path.join(HERE, '..', 'public', 'icons', 'item'))
    a = ap.parse_args()
    try:
        from PIL import Image
    except ImportError:
        sys.exit('needs Pillow: py -m pip install pillow')
    os.makedirs(a.out, exist_ok=True)
    ok = bad = 0
    for name, data in dds_files(a.pak):
        try:
            im = Image.open(io.BytesIO(data)).convert('RGBA')
            im.save(os.path.join(a.out, name.rsplit('.', 1)[0].lower() + '.png'), optimize=True)
            ok += 1
        except Exception as e:      # an odd texture should not stop the rest
            bad += 1
            print(f'skip {name}: {e}', file=sys.stderr)
    print(f'{ok} icons -> {os.path.abspath(a.out)}' + (f' ({bad} skipped)' if bad else ''))


if __name__ == '__main__':
    main()
