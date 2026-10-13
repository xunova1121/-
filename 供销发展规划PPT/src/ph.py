import json, sys
from PIL import Image, ImageDraw, ImageFont

slots = json.load(open(sys.argv[1]))
outdir = sys.argv[2]
FONT = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"
import glob
cands = glob.glob("/usr/share/fonts/**/wqy-zenhei.ttc", recursive=True)
if cands: FONT = cands[0]

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

for s in slots:
    W = int(s["w"] * 200); H = int(s["h"] * 200)
    im = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(im)
    top, bot = (214, 228, 247), (176, 201, 237)
    for y in range(H):
        d.line([(0, y), (W, y)], fill=lerp(top, bot, y / max(H - 1, 1)))
    # simple landscape pictogram: sun + hills
    cx, cy = int(W * 0.5), int(H * 0.40)
    r = int(min(W, H) * 0.07)
    d.ellipse([cx + r * 2.2 - r, cy - r * 1.6 - r, cx + r * 2.2 + r, cy - r * 1.6 + r], fill=(255, 255, 255))
    base = cy + r * 1.4
    d.polygon([(cx - r * 4, base), (cx - r * 1.2, cy - r * 1.2), (cx + r * 1.2, base)], fill=(120, 160, 220))
    d.polygon([(cx - r * 1.5, base), (cx + r * 1.0, cy - r * 0.2), (cx + r * 4, base)], fill=(80, 128, 200))
    # dashed frame
    m = int(min(W, H) * 0.04)
    for x in range(m, W - m, 24):
        d.line([(x, m), (min(x + 12, W - m), m)], fill=(255, 255, 255), width=3)
        d.line([(x, H - m), (min(x + 12, W - m), H - m)], fill=(255, 255, 255), width=3)
    for y in range(m, H - m, 24):
        d.line([(m, y), (m, min(y + 12, H - m))], fill=(255, 255, 255), width=3)
        d.line([(W - m, y), (W - m, min(y + 12, H - m))], fill=(255, 255, 255), width=3)
    fs1 = max(30, int(min(W, H) * 0.075)); fs2 = max(22, int(fs1 * 0.62))
    f1 = ImageFont.truetype(FONT, fs1); f2 = ImageFont.truetype(FONT, fs2)
    t1 = f"可替换图片 {s['id']}"
    t2 = s["hint"]
    # wrap hint
    maxw = W - 4 * m
    lines, cur = [], ""
    for ch in t2:
        if d.textlength(cur + ch, font=f2) > maxw:
            lines.append(cur); cur = ch
        else:
            cur += ch
    if cur: lines.append(cur)
    y = base + int(fs1 * 0.6)
    tw = d.textlength(t1, font=f1)
    d.text(((W - tw) / 2, y), t1, font=f1, fill=(10, 47, 107))
    y += int(fs1 * 1.35)
    for ln in lines:
        lw = d.textlength(ln, font=f2)
        d.text(((W - lw) / 2, y), ln, font=f2, fill=(40, 70, 120))
        y += int(fs2 * 1.3)
    im.save(f"{outdir}/{s['id']}.png")
print("ok", len(slots))
