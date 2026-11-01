"""Рендер рекламных вставок МультоРетик Бота (1920×1080, 30 fps).

python promo_render.py ending <код> <voice.mp3> <out.mp4>   концовка с кодом (~длина озвучки + 1.5 с)
python promo_render.py plashka <voice.mp3> <out.mov>         плашка с альфой (qtrle) для наложения поверх серии
"""
import math, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import imageio_ffmpeg

FF = imageio_ffmpeg.get_ffmpeg_exe()
W, H, FPS = 1920, 1080, 30
FONT = r'C:\Windows\Fonts\ariblk.ttf'
BOT = '@multoretik_bot'
ORANGE, YELLOW, INK, VIOLET = (255, 90, 54), (255, 184, 0), (30, 27, 46), (123, 92, 255)


def dur(mp3):
    out = subprocess.run([FF, '-i', mp3], capture_output=True, text=True, encoding='utf-8', errors='ignore').stderr
    h, m, s = out.split('Duration: ')[1].split(',')[0].split(':')
    return int(h) * 3600 + int(m) * 60 + float(s)


def font(n):
    return ImageFont.truetype(FONT, n)


def ease(t):                     # пружинка 0→1 с перелётом
    t = max(0.0, min(1.0, t))
    return 1 - math.cos(t * math.pi * 4.5) * math.exp(-t * 6)


def text_c(d, xy, s, f, fill, stroke=0, sfill=None):
    d.text(xy, s, font=f, fill=fill, anchor='mm', stroke_width=stroke, stroke_fill=sfill)


def bg(t):
    im = Image.new('RGB', (W, H), (255, 247, 232))
    d = ImageDraw.Draw(im)
    for i in range(-2, 14):                                   # бегущие диагональные полосы
        x = int(i * 180 + (t * 60) % 180)
        d.polygon([(x, 0), (x + 90, 0), (x - 450, H), (x - 540, H)], fill=(255, 238, 205))
    return im


def ending_frame(t, code, total, reveal):
    im = bg(t)
    d = ImageDraw.Draw(im)
    a = ease(t / 0.6)
    text_c(d, (W // 2, int(200 - (1 - a) * 160)), 'СЕКРЕТНЫЙ КОД СЕРИИ', font(84), INK)
    bw, gap = 210, 34
    x0 = W // 2 - (5 * bw + 4 * gap) // 2
    for i, ch in enumerate(code):
        k = ease((t - reveal[i]) / 0.5)
        if t < reveal[i]:
            k = 0
        cx, cy = x0 + i * (bw + gap) + bw // 2, 470
        s = int(bw * (0.35 + 0.65 * k)) if k else 0
        box = Image.new('RGBA', (bw, 260), (0, 0, 0, 0))
        bd = ImageDraw.Draw(box)
        bd.rounded_rectangle([0, 14, bw - 1, 259], 36, fill=(201, 62, 32))
        bd.rounded_rectangle([0, 0, bw - 1, 244], 36, fill=ORANGE)
        bd.text((bw // 2, 122), ch if k else '?', font=font(170), fill='white', anchor='mm')
        if not k:
            bd.rounded_rectangle([0, 0, bw - 1, 244], 36, fill=(232, 222, 205))
            bd.text((bw // 2, 122), '?', font=font(150), fill=(190, 178, 160), anchor='mm')
            s = bw
        b = box.resize((s, int(260 * s / bw)))
        im.paste(b, (cx - s // 2, cy - b.height // 2), b)
    k = ease((t - reveal[-1] - 0.4) / 0.6) if t > reveal[-1] + 0.4 else 0
    if k:
        y = int(800 + (1 - k) * 300)
        d.rounded_rectangle([W // 2 - 560, y - 75, W // 2 + 560, y + 75], 75, fill=VIOLET)
        text_c(d, (W // 2, y - 4), 'Telegram  ' + BOT, font(72), 'white')
        text_c(d, (W // 2, y + 125), 'вводи код → получай карточку героя', font(48), INK)
    return im


def ending(code, voice, out, reveal=None):
    total = dur(voice) + 1.5
    # цифры появляются, когда голос их называет (reveal — из меток времени ElevenLabs; иначе ≈ 1.7 с + 0.75 с на цифру)
    reveal = reveal or [1.7 + i * 0.75 for i in range(5)]
    p = subprocess.Popen([FF, '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '%dx%d' % (W, H), '-r', str(FPS), '-i', '-',
                          '-i', voice, '-af', 'apad', '-t', '%.2f' % total, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
                          '-c:a', 'aac', '-b:a', '192k', out], stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    for f in range(int(total * FPS)):
        p.stdin.write(ending_frame(f / FPS, code, total, reveal).tobytes())
    p.stdin.close(); p.wait()


def plashka_frame(t, total):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    k = ease(t / 0.5) if t < total - 0.4 else max(0.0, 1 - (t - (total - 0.4)) / 0.4)
    if k <= 0:
        return im
    w, h = 1270, 170
    x = int(-w + (w + 60) * k)
    y = H - 260
    sh = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([x + 8, y + 12, x + w + 8, y + h + 12], 40, fill=(0, 0, 0, 110))
    im = Image.alpha_composite(im, sh.filter(ImageFilter.GaussianBlur(10)))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([x, y, x + w, y + h], 40, fill=ORANGE + (255,))
    wob = math.sin(t * 9) * 6
    d.ellipse([x + 30, y + 25 + wob, x + 150, y + 145 + wob], fill=YELLOW + (255,))
    d.text((x + 90, y + 85 + wob), 'КОД', font=font(36), fill=INK, anchor='mm')
    d.text((x + 180, y + 58), 'В этой серии спрятан секретный код!', font=font(46), fill='white', anchor='lm')
    d.text((x + 180, y + 118), 'Смотри внимательно — код в ' + BOT, font=font(36), fill=(255, 236, 214), anchor='lm')
    return im


def plashka(voice, out):
    total = dur(voice) + 0.6
    p = subprocess.Popen([FF, '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '%dx%d' % (W, H), '-r', str(FPS), '-i', '-',
                          '-i', voice, '-af', 'apad', '-t', '%.2f' % total, '-c:v', 'qtrle', '-pix_fmt', 'argb', '-c:a', 'pcm_s16le', out],
                         stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    for f in range(int(total * FPS)):
        p.stdin.write(plashka_frame(f / FPS, total).tobytes())
    p.stdin.close(); p.wait()


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAPTIONS = [(0.00, 'У МультоРетика свой Telegram-бот!'), (0.20, 'В каждой серии спрятан секретный код'),
            (0.45, 'Вводи коды — собирай карточки героев'), (0.70, 'Позови друга — редкая карточка обоим'),
            (0.86, 'Telegram  ' + BOT)]


def explainer(voice, out):
    """Ролик-объяснение: фон-лес и герои канала, подписи по ходу озвучки, карточки выпадают веером."""
    total = dur(voice) + 0.8
    bg = Image.open(os.path.join(ROOT, 'web', 'img', 'bg.webp')).convert('RGB')
    bg = bg.resize((W, int(W * bg.height / bg.width))).crop((0, 0, W, H))
    hero = Image.open(os.path.join(ROOT, 'web', 'img', 'hero.webp')).convert('RGBA')
    hero = hero.resize((1300, int(1300 * hero.height / hero.width)))
    cards = []
    for cid in ('lg-zoloto', 'kr-pyatiglaz', 'sr-luna', 'mr-vedushiy', 'ak-korol'):
        f = os.path.join(ROOT, 'web', 'cards', cid + '.webp')
        if os.path.isfile(f):
            c = Image.open(f).convert('RGBA').resize((230, 230))
            fr = Image.new('RGBA', (250, 250), (0, 0, 0, 0))
            ImageDraw.Draw(fr).rounded_rectangle([0, 0, 249, 249], 26, fill=INK + (255,))
            fr.paste(c, (10, 10)); cards.append(fr)
    p = subprocess.Popen([FF, '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '%dx%d' % (W, H), '-r', str(FPS), '-i', '-',
                          '-i', voice, '-af', 'apad', '-t', '%.2f' % total, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
                          '-c:a', 'aac', '-b:a', '192k', out], stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    for f in range(int(total * FPS)):
        t = f / FPS
        im = bg.copy().convert('RGBA')
        k = ease(t / 0.8)
        im.alpha_composite(hero, ((W - hero.width) // 2, int(40 - (1 - k) * 400)))
        d = ImageDraw.Draw(im)
        cap = [c for s0, c in CAPTIONS if t >= s0 * total][-1]
        start = [s0 for s0, c in CAPTIONS if c == cap][0] * total
        kc = ease((t - start) / 0.45)
        y = int(560 + (1 - kc) * 60)
        tw = d.textlength(cap, font=font(70))
        d.rounded_rectangle([W // 2 - tw / 2 - 50, y - 62, W // 2 + tw / 2 + 50, y + 62], 40,
                            fill=(VIOLET if cap.startswith('Telegram') else (59, 34, 16)) + (235,), outline=INK, width=6)
        text_c(d, (W // 2, y), cap, font(70), 'white', 6, INK)
        if t > 0.45 * total:                                   # карточки веером
            n = len(cards)
            for i, c in enumerate(cards):
                kk = ease((t - 0.45 * total - i * 0.18) / 0.6)
                if kk <= 0:
                    continue
                ang = (i - (n - 1) / 2) * 9
                r = c.rotate(-ang, expand=True, resample=Image.BICUBIC)
                x = int(W / 2 + (i - (n - 1) / 2) * 230 - r.width / 2)
                yy = int(H - 300 + abs(i - (n - 1) / 2) * 18 + (1 - kk) * 400)
                im.alpha_composite(r, (x, yy))
        p.stdin.write(im.convert('RGB').tobytes())
    p.stdin.close(); p.wait()


if __name__ == '__main__':
    if sys.argv[1] == 'ending':
        ending(sys.argv[2], sys.argv[3], sys.argv[4])
    elif sys.argv[1] == 'explainer':
        explainer(sys.argv[2], sys.argv[3])
    else:
        plashka(sys.argv[2], sys.argv[3])
