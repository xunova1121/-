#!/usr/bin/env python3
"""从页面自带的深色样式表自动生成浅色覆盖表。

用法：python3 src/gis/gen-light.py 源单页.html
输出：src/gis/assets/light-auto.css

页面自带样式有 777 条规则、169 种背景色、247 种文字色，全是手写深色十六进制，
逐条手改不现实。这里按规则解析，把「深背景 → 浅面」「浅文字 → 深墨」
「深描边 → 浅描边」成对翻过来，并保留语义色相（红仍是红、绿仍是绿），
只把明度挪到浅底可读的区间。

生成的表由 build.py 先注入，手写的 gis-light.css 放在其后，
所以人工判断始终盖过自动映射。
"""
import colorsys, re, sys, pathlib

BASE = pathlib.Path(__file__).parent
OUT  = BASE / 'assets' / 'light-auto.css'

# 浅色面：按原背景的深浅分四档，保持原有的层次关系
SURFACES = ['#ffffff', '#f7fafd', '#eef4fa', '#e4eef7']
EDGE_LIGHT, EDGE_LIGHTER = '#bed4e6', '#d8e6f2'
INK, INK_2, INK_3 = '#0d2b44', '#3b647e', '#6b8ba0'

HEX = re.compile(r'#([0-9a-fA-F]{3,8})\b')
RGB = re.compile(r'rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)')

def parse_color(tok):
    tok = tok.strip()
    m = HEX.fullmatch(tok)
    if m:
        h = m.group(1)
        if len(h) == 3: h = ''.join(c * 2 for c in h)
        if len(h) in (6, 8):
            return tuple(int(h[i:i+2], 16) for i in (0, 2, 4)), (int(h[6:8], 16) / 255 if len(h) == 8 else 1.0)
    m = RGB.fullmatch(tok)
    if m:
        return (int(m.group(1)), int(m.group(2)), int(m.group(3))), float(m.group(4) or 1)
    return None

def lum(rgb):
    def ch(c):
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

def sat(rgb):
    r, g, b = (x / 255 for x in rgb)
    return colorsys.rgb_to_hls(r, g, b)[2]

def darken_keep_hue(rgb, target_l=0.36):
    """保留色相与饱和度，把明度压到浅底上可读的位置（语义色用）。"""
    r, g, b = (x / 255 for x in rgb)
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    r, g, b = colorsys.hls_to_rgb(h, target_l, max(s, 0.45))
    return '#%02x%02x%02x' % (int(r * 255), int(g * 255), int(b * 255))

def map_background(tok):
    c = parse_color(tok)
    if not c: return None
    rgb, a = c
    if a < 0.25: return None                      # 近乎透明的遮罩，保持原样
    L = lum(rgb)
    if L >= 0.30: return None                     # 本来就不深，不动
    if sat(rgb) > 0.45 and L > 0.10:              # 饱和的强调底（按钮、徽标）
        return darken_keep_hue(rgb, 0.88)
    idx = 0 if L < 0.035 else 1 if L < 0.075 else 2 if L < 0.14 else 3
    return SURFACES[idx]

def map_color(tok):
    c = parse_color(tok)
    if not c: return None
    rgb, _ = c
    L, S = lum(rgb), sat(rgb)
    if L < 0.28: return None                      # 已是深色，多半印在浅片上
    if S > 0.40: return darken_keep_hue(rgb, 0.33)   # 语义色：压暗但保色相，过 3:1
    return INK if L > 0.62 else INK_2 if L > 0.40 else INK_3

def map_border(tok):
    c = parse_color(tok)
    if not c: return None
    rgb, _ = c
    L = lum(rgb)
    if L >= 0.30: return None
    if sat(rgb) > 0.45: return darken_keep_hue(rgb, 0.62)
    return EDGE_LIGHT if L > 0.06 else EDGE_LIGHTER

def convert_decl(prop, value):
    """返回替换后的值，或 None 表示这条声明不需要覆盖。"""
    p = prop.strip().lower()
    if p.startswith('--'):
        # CSS 变量按「变量名」判角色更稳：单看亮度会把 --red(#ff5b68, 亮度 0.299)
        # 判成面，翻成淡粉；把 --muted 判成面，翻成浅蓝，两处都丢掉了语义。
        c = parse_color(value)
        if not c: return None
        name = p[2:]
        if any(k in name for k in ('bg', 'panel', 'surface', 'line', 'border', 'edge', 'track')):
            return map_background(value)
        return map_color(value)
    if p.startswith('background'):
        if 'gradient' in value:                   # 渐变取首个色标定档，压成纯色
            m = HEX.search(value) or RGB.search(value)
            if not m: return None
            flat = map_background(m.group(0))
            return flat
        return map_background(value)
    if p == 'color':
        return map_color(value)
    if p.startswith('border') and 'color' not in p and ':' not in value:
        m = HEX.search(value) or RGB.search(value)
        if not m: return None
        nb = map_border(m.group(0))
        return value[:m.start()] + nb + value[m.end():] if nb else None
    if p.endswith('color'):
        return map_border(value) if 'border' in p else map_color(value)
    return None

def split_rules(css):
    """按花括号深度切块，正确区分 @media 内外。
    用正则按 @media 切分会把媒体块之后的规则一起裹进媒体查询，
    大屏下整段失效——这是第一版的 bug，改成逐字符走。"""
    out, i, n = [], 0, len(css)
    while i < n:
        j = css.find('{', i)
        if j < 0: break
        prelude = css[i:j].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            if css[k] == '{': depth += 1
            elif css[k] == '}': depth -= 1
            k += 1
        body = css[j + 1:k - 1]
        if prelude.startswith('@'):
            if prelude.startswith('@media'):
                for sel, decls, _ in split_rules(body):
                    out.append((sel, decls, prelude))
            # @keyframes / @font-face 等不参与配色翻转
        else:
            out.append((prelude, body, None))
        i = k
    return out

def main(src):
    html = pathlib.Path(src).read_text(encoding='utf-8')
    # 页面自带的两张深色表：主样式表 + v10x GIS 覆盖层
    sheets = []
    a = html.find('<style>'); b = html.find('</style>', a)
    sheets.append(html[a + 7:b])
    m = re.search(r'<style id="v10\d-real-gis-style">(.*?)</style>', html, re.S)
    if m: sheets.append(m.group(1))
    css = re.sub(r'/\*.*?\*/', '\n'.join(sheets), flags=re.S) if False else \
          re.sub(r'/\*.*?\*/', '', '\n'.join(sheets), flags=re.S)
    out, converted = [], 0
    for sel, body, media in split_rules(css):
        sel = ' '.join(sel.split())
        if not sel or sel.startswith('@') or re.fullmatch(r'(from|to|[\d.]+%)', sel):
            continue
        decls = []
        for d in body.split(';'):
            if ':' not in d or '{' in d: continue
            prop, _, val = d.partition(':')
            nv = convert_decl(prop, val)
            if nv: decls.append('%s:%s!important' % (prop.strip(), nv))
        if not decls: continue
        converted += 1
        rule = '%s{%s}' % (sel, ';'.join(decls))
        out.append('%s{%s}' % (media, rule) if media else rule)
    OUT.parent.mkdir(exist_ok=True)
    header = ('/* 由 gen-light.py 从页面自带样式自动生成，请勿手改。\n'
              '   手工微调写在 gis-light.css（注入顺序在本表之后，因而始终取胜）。*/\n')
    OUT.write_text(header + '\n'.join(out) + '\n', encoding='utf-8')
    print('生成 %d 条覆盖规则 -> %s (%d KB)' % (converted, OUT, len(OUT.read_text(encoding='utf-8')) // 1024))

if __name__ == '__main__':
    main(sys.argv[1])
