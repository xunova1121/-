#!/usr/bin/env python3
"""从页面内嵌实拍图生成「重点功能」展示图（一张图中部使用）。

用法：python3 src/gis/gen-shots.py 源单页.html
输出：src/gis/assets/shot_*.b64

选图与功能的对应关系写在 SHOTS 里，都是页面本来就有的照片，不引入外部素材。
统一做轻度冷调压暗，使其嵌入深色驾驶舱界面不刺眼，但保持可辨识。
"""
import base64, hashlib, io, re, sys, pathlib
from PIL import Image, ImageEnhance

BASE = pathlib.Path(__file__).parent
OUT  = BASE / 'assets'; OUT.mkdir(exist_ok=True)

SHOTS = [
    ("77436f4d", "watch"),   # 驾驶舱值守 —— 视频行为识别
    ("b2bb6196", "collide"), # 商船近距 —— 商渔防碰撞
    ("dc6be801", "enforce"), # 执法船靠帮 —— 海上执法处置
    ("e61756f2", "board"),   # 登临检查 —— 现场核查取证
]

def load(html_path):
    s = pathlib.Path(html_path).read_text(encoding='utf-8')
    found = {}
    for _, b64 in re.findall(r'data:image/(webp|jpeg|png);base64,([A-Za-z0-9+/=]+)', s):
        h = hashlib.md5(b64.encode()).hexdigest()[:8]
        if h not in found:
            found[h] = Image.open(io.BytesIO(base64.b64decode(b64))).convert('RGB')
    return found

def grade(im):
    """裁成 16:9、压暗偏冷，贴合深色界面。"""
    w, h = im.size
    tw, th = 16, 9
    if w / h > tw / th:                    # 太宽 → 裁两侧
        nw = int(h * tw / th); im = im.crop(((w - nw) // 2, 0, (w + nw) // 2, h))
    else:                                  # 太高 → 裁上下，略偏上保留主体
        nh = int(w * th / tw); top = int((h - nh) * 0.38)
        im = im.crop((0, top, w, top + nh))
    im = im.resize((480, 270), Image.LANCZOS)
    im = ImageEnhance.Contrast(im).enhance(1.08)
    im = ImageEnhance.Brightness(im).enhance(0.74)
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b = px[x, y]
            px[x, y] = (int(r * 0.88), int(g * 0.96), min(255, int(b * 1.10) + 6))
    return im

def main(src_html):
    pool = load(src_html)
    for h, name in SHOTS:
        if h not in pool:
            raise SystemExit('页面里找不到图片 %s' % h)
        buf = io.BytesIO()
        grade(pool[h]).save(buf, 'JPEG', quality=72, optimize=True)
        raw = buf.getvalue()
        (OUT / ('shot_%s.b64' % name)).write_text(base64.b64encode(raw).decode(), encoding='utf-8')
        print('shot_%s: %dKB' % (name, len(raw) // 1024))

if __name__ == '__main__':
    main(sys.argv[1])
