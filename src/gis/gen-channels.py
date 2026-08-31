#!/usr/bin/env python3
"""从页面内嵌的渔船实拍图生成雷达视图的两路光电通道画面。

用法：  python3 src/gis/gen-channels.py 源单页.html
输出：  src/gis/assets/vis.b64   可见光通道（夜视调色）
        src/gis/assets/therm.b64 热成像通道（ironbow 伪彩）

说明：热成像是对实拍图的**模拟渲染**，不是真的红外数据。
日间可见光的亮度分布和红外正好相反（海面亮、船体暗），
所以热度不取亮度，而是按船体区域合成、用实拍细节做纹理调制。
"""
import base64, hashlib, re, sys, pathlib
from PIL import Image, ImageEnhance, ImageFilter, ImageChops, ImageDraw

BASE = pathlib.Path(__file__).parent
OUT  = BASE / 'assets'; OUT.mkdir(exist_ok=True)
# 页面里那张海上作业渔船外景（按内容哈希认，不依赖出现顺序）
WANT = '0ac4092a'

def find_source(html_path):
    s = pathlib.Path(html_path).read_text(encoding='utf-8')
    for _, b64 in re.findall(r'data:image/(webp|jpeg|png);base64,([A-Za-z0-9+/=]+)', s):
        if hashlib.md5(b64.encode()).hexdigest()[:8] == WANT:
            return Image.open(__import__('io').BytesIO(base64.b64decode(b64))).convert('RGB')
    raise SystemExit('没在页面里找到目标底图（哈希 %s）' % WANT)

def ironbow():
    stops = [(0,(3,5,26)),(38,(14,20,88)),(80,(70,24,120)),(124,(156,30,86)),
             (166,(224,74,26)),(206,(250,158,20)),(234,(255,226,96)),(255,(255,255,240))]
    lr, lg, lb = [], [], []
    for v in range(256):
        for i in range(len(stops)-1):
            a, ca = stops[i]; b, cb = stops[i+1]
            if a <= v <= b:
                t = (v-a)/(b-a) if b > a else 0
                lr.append(int(ca[0]+(cb[0]-ca[0])*t))
                lg.append(int(ca[1]+(cb[1]-ca[1])*t))
                lb.append(int(ca[2]+(cb[2]-ca[2])*t))
                break
    return lr, lg, lb

def main(src_html):
    src  = find_source(src_html)
    crop = src.crop((90, 250, 1350, 900)).resize((672, 347), Image.LANCZOS)

    # ---- 可见光：夜视调色 ----
    vis = ImageEnhance.Brightness(ImageEnhance.Contrast(crop).enhance(1.25)).enhance(0.44)
    px = vis.load()
    import random; random.seed(7)
    for y in range(vis.height):
        for x in range(vis.width):
            r, g, b = px[x, y]
            n = random.randint(-6, 6)                       # 传感器噪点
            px[x, y] = (max(0, min(255, int(r*0.52)+n)),
                        max(0, min(255, int(g*0.80)+n)),
                        max(0, min(255, min(255, int(b*1.30)+16)+n)))
    vis.save(OUT/'_vis.jpg', quality=74, optimize=True)

    # ---- 热成像：按船体区域合成热度 ----
    gray = crop.convert('L'); w, h = gray.size
    hull = Image.new('L', (w, h), 0); d = ImageDraw.Draw(hull)
    d.polygon([(118,250),(140,196),(196,176),(300,170),(392,178),(452,196),(462,228),
               (430,258),(300,268),(180,264)], fill=255)              # 船体
    d.polygon([(196,120),(268,112),(300,118),(306,176),(200,178)], fill=255)   # 上层建筑
    d.polygon([(300,150),(404,158),(430,196),(310,190)], fill=210)            # 后甲板
    hull = hull.filter(ImageFilter.GaussianBlur(3.4))
    detail = ImageEnhance.Contrast(gray.filter(ImageFilter.FIND_EDGES)
                                   .filter(ImageFilter.GaussianBlur(1.1))).enhance(2.2)
    hp, dp = hull.load(), detail.load()
    heat = Image.new('L', (w, h), 0); ht = heat.load()
    for y in range(h):
        if   y < h*0.30: base = 5                                    # 天空最冷
        elif y < h*0.55: base = 11                                   # 岸线山体
        else:            base = 16 + int(14*(y-h*0.55)/(h*0.45))     # 海面，近处略暖
        for x in range(w):
            ht[x, y] = min(255, base + int(hp[x, y]/255.0*(126 + 0.46*dp[x, y])))
    hot = Image.new('L', (w, h), 0); dh = ImageDraw.Draw(hot)        # 机舱排气
    dh.ellipse([232,150,296,196], fill=150); dh.ellipse([246,160,282,186], fill=205)
    dh.ellipse([196,118,236,150], fill=120)
    heat = ImageChops.add(heat, hot.filter(ImageFilter.GaussianBlur(7)))
    wake = Image.new('L', (w, h), 0); dw = ImageDraw.Draw(wake)      # 尾流余温
    dw.ellipse([120,252,470,300], fill=54); dw.ellipse([170,258,400,288], fill=76)
    heat = ImageChops.add(heat, wake.filter(ImageFilter.GaussianBlur(13)))
    heat = heat.filter(ImageFilter.GaussianBlur(0.7))
    lr, lg, lb = ironbow()
    Image.merge('RGB', (heat.point(lr), heat.point(lg), heat.point(lb))) \
         .save(OUT/'_therm.jpg', quality=80, optimize=True)

    for name, out in (('_vis', 'vis.b64'), ('_therm', 'therm.b64')):
        raw = (OUT/f'{name}.jpg').read_bytes()
        (OUT/out).write_text(base64.b64encode(raw).decode(), encoding='utf-8')
        print(f'{out}: {len(raw)//1024}KB')

if __name__ == '__main__':
    main(sys.argv[1])
