"""Постеры «Босс дня» для рассылки бота: web/boss/<id>.jpg (1280×720) для всех эпических и легендарных карточек.
python tools/boss_poster.py            — карточки берутся из базы (cards, active, epic/legend); готовые не перерисовываются
python tools/boss_poster.py --all      — перерисовать все"""
import json, os, sys, textwrap, urllib.request
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'web', 'boss')
W, H = 1280, 720
INK = (14, 7, 25); RED = (255, 77, 77); MUTED = (191, 169, 230)
RARE = {'legend': (255, 200, 58), 'epic': (193, 91, 255)}
FB = r'C:\Windows\Fonts\ariblk.ttf'
FR = r'C:\Windows\Fonts\arialbd.ttf'
font = lambda f, n: ImageFont.truetype(f, n)


def fit(d, s, f, size, width, lines=2):
    """Самый крупный кегль, при котором имя влезает в lines строк ширины width."""
    while size > 30:
        fnt = font(f, size)
        avg = d.textlength('о', font=fnt)
        wrap = textwrap.wrap(s, max(4, int(width / avg)))
        if len(wrap) <= lines and all(d.textlength(x, font=fnt) <= width for x in wrap):
            return fnt, wrap
        size -= 4
    return font(f, 30), textwrap.wrap(s, 20)[:lines]


def poster(card, out):
    bg = Image.open(os.path.join(ROOT, 'web', 'img', 'bg.webp')).convert('RGB')
    bg = bg.resize((W, int(W * bg.height / bg.width))).crop((0, 0, W, H)).filter(ImageFilter.GaussianBlur(14))
    im = ImageEnhance.Brightness(bg).enhance(0.38).convert('RGBA')
    d = ImageDraw.Draw(im)
    # карточка слева
    S = 560
    art = Image.open(os.path.join(ROOT, 'web', card['img'])).convert('RGBA').resize((S - 28, S - 28), Image.LANCZOS)
    x0, y0 = 70, (H - S) // 2
    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).rounded_rectangle([x0 - 10, y0 - 10, x0 + S + 10, y0 + S + 10], 44, fill=RARE[card['rarity']] + (150,))
    im = Image.alpha_composite(im, glow.filter(ImageFilter.GaussianBlur(28)))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([x0, y0, x0 + S, y0 + S], 36, fill=RARE[card['rarity']])
    mask = Image.new('L', art.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, art.width - 1, art.height - 1], 26, fill=255)
    im.paste(art, (x0 + 14, y0 + 14), mask)
    # текст справа
    tx, tw = x0 + S + 64, W - (x0 + S + 64) - 60
    lab = font(FB, 30)
    lw = d.textlength('БОСС ДНЯ', font=lab)
    d.rounded_rectangle([tx, 150, tx + lw + 40, 202], 14, fill=RED)
    d.text((tx + 20, 176), 'БОСС ДНЯ', font=lab, fill='white', anchor='lm')
    fnt, lines = fit(d, card['name'], FB, 76, tw)
    y = 250
    for ln in lines:
        d.text((tx, y), ln, font=fnt, fill='white', anchor='lt')
        y += int(fnt.size * 1.12)
    y += 22
    for ln in ['Победим вместе до полуночи —', 'и его карточка будет у тебя']:
        d.text((tx, y), ln, font=font(FR, 32), fill=MUTED, anchor='lt')
        y += 44
    d.text((tx, H - 110), '@multoretik_bot', font=font(FB, 30), fill=RARE['legend'], anchor='lt')
    im.convert('RGB').save(out, quality=88)


def cards_from_db():
    sec = json.load(open(os.path.join(ROOT, 'secrets.local.json'), encoding='utf-8'))
    url = 'https://%s.supabase.co/rest/v1/cards?select=id,name,rarity,img&active=eq.true&rarity=in.(epic,legend)' % sec['supabase_ref']
    req = urllib.request.Request(url, headers={'apikey': sec['supabase_service_role'], 'Authorization': 'Bearer ' + sec['supabase_service_role']})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    n = 0
    for c in cards_from_db():
        out = os.path.join(OUT, c['id'] + '.jpg')
        if os.path.exists(out) and '--all' not in sys.argv:
            continue
        poster(c, out)
        n += 1
    print('постеров:', n)
