"""Нарезать листы ChatGPT (3×2) на карточки web/cards/<id>.webp и прописать их в базу (cards.img).

python tools/cut_cards.py            нарезать все готовые листы art/sheetN.png
"""
import json, os, sys
import requests
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHEETS = {
    1: ['mr-ten', 'mr-pomehi', 'mr-rasskaz', 'mr-vedushiy', 'kr-polnoch', 'kr-shoroh'],
    2: ['kr-usach', 'kr-pyatiglaz', 'sr-ulybaka', 'sr-kolyuchiy', 'sr-dvoynik', 'sr-luna'],
    3: ['so-soyka', 'so-kadr', 'so-efir', 'so-hozyain', 'ak-antikot', 'ak-gorod'],
    4: ['ak-mer', 'ak-korol', 'lg-zoloto', 'lg-poslednyaya', 'lg-hranitel', 'lg-kot-titry'],
}
INSET = 0.025          # срезать край клетки (тёмные промежутки сетки)


def cut(n, ids):
    src = os.path.join(ROOT, 'art', 'sheet%d.png' % n)
    if not os.path.isfile(src):
        return []
    im = Image.open(src).convert('RGB')
    W, H = im.size
    cw, ch = W / 3, H / 2
    done = []
    for k, cid in enumerate(ids):
        x, y = (k % 3) * cw, (k // 3) * ch
        dx, dy = cw * INSET, ch * INSET
        cell = im.crop((int(x + dx), int(y + dy), int(x + cw - dx), int(y + ch - dy)))
        s = min(cell.size)                                   # квадрат по центру
        cell = cell.crop(((cell.width - s) // 2, (cell.height - s) // 2, (cell.width + s) // 2, (cell.height + s) // 2))
        cell = cell.resize((480, 480), Image.LANCZOS)
        cell.save(os.path.join(ROOT, 'web', 'cards', cid + '.webp'), quality=84)
        done.append(cid)
    return done


def main():
    os.makedirs(os.path.join(ROOT, 'web', 'cards'), exist_ok=True)
    extra = json.load(open(os.path.join(ROOT, 'art', 'cartoon_cards.json'), encoding='utf-8'))     # листы 5-8: герои мультиков
    rows = {}
    for sh in extra:
        SHEETS[sh['sheet']] = [c['id'] for c in sh['cards']]
        for c in sh['cards']:
            rows[c['id']] = (c['name'], sh['channel'], c['rarity'])
    ids = [cid for n, lst in SHEETS.items() for cid in cut(n, lst)]
    print('нарезано:', len(ids))
    if not ids:
        return
    s = json.load(open(os.path.join(ROOT, 'secrets.local.json'), encoding='utf-8'))
    new = [i for i in ids if i in rows]
    if new:
        q0 = "insert into cards (id, name, channel, rarity, img) values %s on conflict (id) do update set name = excluded.name, img = excluded.img" % ','.join(
            "('%s','%s','%s','%s','cards/%s.webp')" % (i, rows[i][0], rows[i][1], rows[i][2], i) for i in new)
        r0 = requests.post('https://api.supabase.com/v1/projects/%s/database/query' % s['supabase_ref'],
                           headers={'Authorization': 'Bearer ' + s['supabase_pat']}, json={'query': q0}, timeout=60)
        print('новые карточки в базе:', len(new), r0.status_code)
    q = "update cards set img = 'cards/' || id || '.webp' where id in (%s)" % ','.join("'%s'" % i for i in ids)
    r = requests.post('https://api.supabase.com/v1/projects/%s/database/query' % s['supabase_ref'],
                      headers={'Authorization': 'Bearer ' + s['supabase_pat']}, json={'query': q}, timeout=60)
    print('база:', r.status_code)


if __name__ == '__main__':
    main()
