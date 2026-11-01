"""Рендер рекламных вставок МультоРетик Бота (1920×1080, 30 fps).

python promo_render.py ending <код> <voice.mp3> <out.mp4>   концовка с кодом (~длина озвучки + 1.5 с)
python promo_render.py plashka <voice.mp3> <out.mov>         плашка с альфой (qtrle) для наложения поверх серии
"""
import math, subprocess, sys
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


def ending(code, voice, out):
    total = dur(voice) + 1.5
    # цифры появляются примерно когда голос их называет (≈ 1.6 с вступления, затем каждые ~0.75 с)
    reveal = [1.7 + i * 0.75 for i in range(5)]
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
    w, h = 1180, 170
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
    d.text((x + 180, y + 58), 'В конце серии — секретный код!', font=font(46), fill='white', anchor='lm')
    d.text((x + 180, y + 118), 'Досмотри и введи в ' + BOT, font=font(36), fill=(255, 236, 214), anchor='lm')
    return im


def plashka(voice, out):
    total = dur(voice) + 0.6
    p = subprocess.Popen([FF, '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '%dx%d' % (W, H), '-r', str(FPS), '-i', '-',
                          '-i', voice, '-af', 'apad', '-t', '%.2f' % total, '-c:v', 'qtrle', '-pix_fmt', 'argb', '-c:a', 'pcm_s16le', out],
                         stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    for f in range(int(total * FPS)):
        p.stdin.write(plashka_frame(f / FPS, total).tobytes())
    p.stdin.close(); p.wait()


if __name__ == '__main__':
    if sys.argv[1] == 'ending':
        ending(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        plashka(sys.argv[2], sys.argv[3])
