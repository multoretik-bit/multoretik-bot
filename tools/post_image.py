"""Картинка поста в Telegram-канал: «у МультоРетика свой бот» — карточки веером, Ретик с лупой, @multoretik_bot."""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H = 1600, 1200
INK = (14, 7, 25); GOLD = (255, 200, 58); VIOLET = (123, 92, 255); WOOD = (184, 120, 56); WOOD_D = (59, 34, 16)
F = r'C:\Windows\Fonts\ariblk.ttf'
font = lambda n: ImageFont.truetype(F, n)
RARE = {'legend': GOLD, 'epic': (193, 91, 255), 'rare': (74, 168, 255), 'common': (156, 143, 184)}

bg = Image.open(os.path.join(ROOT, 'web', 'img', 'bg.webp')).convert('RGB')
bg = bg.resize((W, int(W * bg.height / bg.width))).crop((0, 0, W, H))
bg = ImageEnhance.Brightness(bg).enhance(0.9).convert('RGBA')
grad = Image.new('RGBA', (W, H)); gd = ImageDraw.Draw(grad)
for y in range(H):
    gd.line([(0, y), (W, y)], fill=(26, 15, 46, int(40 + 170 * (y / H) ** 1.6)))
im = Image.alpha_composite(bg, grad)
d = ImageDraw.Draw(im)

def text(xy, s, size, fill='white', stroke=10, sfill=INK, anchor='mm'):
    d.text(xy, s, font=font(size), fill=fill, anchor=anchor, stroke_width=stroke, stroke_fill=sfill)

# заголовок
text((W // 2, 105), 'У МУЛЬТОРЕТИКА', 74, 'white', 12)
text((W // 2, 200), 'СВОЙ ТЕЛЕГРАМ-БОТ!', 92, GOLD, 14)

# карточки веером
cards = [('kt-korzhik', 'rare'), ('sm-krosh', 'rare'), ('pp-peppa', 'legend'), ('ms-masha', 'legend'), ('lg-zoloto', 'legend'),
         ('sm-losyash', 'epic'), ('lu-luntik', 'epic')]
n = len(cards); cw = 300
for i, (cid, rar) in enumerate(cards):
    art = Image.open(os.path.join(ROOT, 'web', 'cards', cid + '.webp')).convert('RGBA').resize((cw - 28, cw - 28))
    card = Image.new('RGBA', (cw, cw + 10), (0, 0, 0, 0)); cd = ImageDraw.Draw(card)
    cd.rounded_rectangle([0, 0, cw - 1, cw + 9], 30, fill=INK)
    cd.rounded_rectangle([8, 8, cw - 9, cw - 9], 24, fill=RARE[rar])
    mask = Image.new('L', art.size, 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, art.width - 1, art.height - 1], 18, fill=255)
    card.paste(art, (14, 14), mask)
    k = i - (n - 1) / 2
    r = card.rotate(-k * 7, expand=True, resample=Image.BICUBIC)
    sh = Image.new('RGBA', r.size, (0, 0, 0, 0)); sh.putalpha(r.split()[3].point(lambda a: int(a * 0.55)))
    x = int(W / 2 + k * 190 - r.width / 2); y = int(300 + abs(k) ** 1.5 * 22)
    blk = Image.new('RGBA', r.size, INK + (0,)); blk.putalpha(r.split()[3].point(lambda a: int(a * 0.5)))
    im.alpha_composite(blk.filter(ImageFilter.GaussianBlur(10)), (x + 10, y + 16))
    im.alpha_composite(r, (x, y))
d = ImageDraw.Draw(im)
# звёздочки
import random
random.seed(7)
for _ in range(14):
    x, y, s = random.randint(60, W - 60), random.randint(250, 700), random.randint(12, 26)
    d.polygon([(x, y - s), (x + s * .3, y - s * .3), (x + s, y), (x + s * .3, y + s * .3), (x, y + s), (x - s * .3, y + s * .3), (x - s, y), (x - s * .3, y - s * .3)],
              fill=GOLD, outline=INK)

# доска с объяснением
py = 790
d.rounded_rectangle([170, py + 8, W - 170, py + 178], 34, fill=WOOD_D)
d.rounded_rectangle([170, py, W - 170, py + 170], 34, fill=WOOD, outline=WOOD_D, width=6)
text((W // 2, py + 58), 'В конце каждой серии — секретный код', 50, 'white', 8, WOOD_D)
text((W // 2, py + 122), 'Вводи коды и собирай карточки героев!', 46, (255, 236, 205), 7, WOOD_D)

# кнопка
by = 1060
d.rounded_rectangle([W // 2 - 420, by - 62, W // 2 + 420, by + 72], 70, fill=INK)
d.rounded_rectangle([W // 2 - 420, by - 70, W // 2 + 420, by + 62], 70, fill=VIOLET, outline=INK, width=7)
text((W // 2, by - 4), '@multoretik_bot', 76, 'white', 9)

# Ретик с лупой — слева внизу
rt = Image.open(os.path.join(ROOT, 'web', 'img', 'retik.webp')).convert('RGBA')
rt = rt.resize((250, int(250 * rt.height / rt.width)))
fade = Image.new('L', rt.size, 255); fd = ImageDraw.Draw(fade)
for y in range(rt.height - 60, rt.height):
    fd.line([(0, y), (rt.width, y)], fill=int(255 * (rt.height - y) / 60))
rt.putalpha(Image.composite(rt.split()[3], Image.new('L', rt.size, 0), fade))
im.alpha_composite(rt, (70, H - rt.height + 10))
out = os.path.join(ROOT, 'promo', 'post_bot.jpg')
im.convert('RGB').save(out, quality=92)
print(out)
