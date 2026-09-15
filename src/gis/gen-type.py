#!/usr/bin/env python3
"""从页面自带样式表自动生成「放大字号」覆盖表。

用法：python3 src/gis/gen-type.py 源单页.html
输出：src/gis/assets/type-auto.css

为什么要生成而不是手写：页面自带样式里 font-size 的分布是
  7px×55  8px×65  9px×51  10px×26  11px×23  12px×21 …
也就是说模块正文的大头压在 7–9px。手工挑二十来个选择器改，
改到的是标题和 KPI，正文还是小——这正是「所有模块内容字体还是小」的原因。

放大字号本身不难，难的是**不错位**。页面到处是写死的
`height:68px` / `height:58px` 这类盒子，字一大就顶出去或者被裁掉。
所以本表同时做两件事：
  1. 按档位整体放大 font-size / line-height；
  2. 把「会装文字的固定高度盒子」换成 min-height + height:auto，让它顶开而不是裁掉。
"""
import re, sys, pathlib

BASE = pathlib.Path(__file__).parent
OUT  = BASE / 'assets' / 'type-auto.css'

# 字号档位表：左边是页面原值，右边是放大后。
# 小端抬得最狠（7→11.5，1.64 倍）——那一档原本就是没法看的；
# 大端只 +2，标题本来够大，跟着一起放会把版面撑散。
def scale_font(v):
    if v <= 7:    return 11.5
    if v <= 8.5:  return 12
    if v <= 9.5:  return 12.5
    if v <= 10.5: return 13
    if v <= 11.5: return 13.5
    if v <= 12.5: return 14
    if v <= 13.5: return 14.5
    if v <= 14.5: return 15.5
    if v <= 15.5: return 16
    return round(v + 2, 1)

# 行高：跟着字号走，但按比例而不是按档位，避免把本来就松的行距撑得更松
def scale_lh(v):
    return round(v * 1.18, 1) if v >= 10 else None

# 这些选择器的固定高度不动：它们是画面/图形的画布，不是文字容器。
# 改成 auto 会让里面绝对定位的子元素失去参照，或者干脆塌掉。
# 名单要克制：第一版把 .conference / .aiScene / .inference 也放了进来，
# 结果 .conference 那个写死的 445px 装不下放大后的会场，整块被裁掉 180px。
# 判据是「这块东西里有没有需要读的文字」——有就让它顶开。
KEEP_HEIGHT = re.compile(
    r'\.(map|radar|radarScene|video|videos|videowall|mainFeed'
    r'|evidenceMedia|conferenceMain|conferenceTiles|qr)\b')

def split_rules(css):
    """按花括号深度切块，正确区分 @media 内外。与 gen-light.py 同一套。"""
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
        else:
            out.append((prelude, body, None))
        i = k
    return out

PX = r'(-?[\d.]+)px'

def convert(sel, body):
    """返回这条规则需要补的声明列表。"""
    decls = []
    has_width_px = re.search(r'(?<![-\w])width\s*:\s*[\d.]+px', body) is not None
    is_round     = 'border-radius:50%' in body.replace(' ', '')
    for d in body.split(';'):
        if ':' not in d or '{' in d: continue
        prop, _, val = d.partition(':')
        p, v = prop.strip().lower(), val.strip()

        if p == 'font-size':
            m = re.fullmatch(PX, v)
            if m:
                nv = scale_font(float(m.group(1)))
                decls.append('font-size:%gpx!important' % nv)

        elif p == 'line-height':
            m = re.fullmatch(PX, v)
            if m:
                nv = scale_lh(float(m.group(1)))
                if nv: decls.append('line-height:%gpx!important' % nv)

        elif p in ('grid-template-columns', 'grid-template-rows'):
            # 固定 px 的栏宽是给文字留的槽（时间戳、评分、编号）。字一大就裁，
            # 智能预警那列 02:25:04 就是这么被切掉最后一位的。
            # 24px 以下是圆点/图标，90px 以上是整块面板，都不动。
            def _grow(m):
                x = float(m.group(1))
                return ('%gpx' % round(x * 1.25)) if 24 <= x <= 90 else m.group(0)
            nv = re.sub(PX, _grow, v)
            if nv != v:
                decls.append('%s:%s!important' % (p, nv))

        elif p == 'height':
            m = re.fullmatch(PX, v)
            if not m: continue
            h = float(m.group(1))
            # 图标/圆点（同时写死宽高、或者是圆）不动；20px 以下的也不动，
            # 那是分隔线、进度条一类，不装文字。
            if h < 20 or has_width_px or is_round: continue
            if KEEP_HEIGHT.search(sel): continue
            decls.append('height:auto!important')
            decls.append('min-height:%gpx' % h)
    return decls

def main(src):
    html = pathlib.Path(src).read_text(encoding='utf-8')
    sheets = []
    a = html.find('<style>'); b = html.find('</style>', a)
    sheets.append(html[a + 7:b])
    m = re.search(r'<style id="v10\d-real-gis-style">(.*?)</style>', html, re.S)
    if m: sheets.append(m.group(1))
    css = re.sub(r'/\*.*?\*/', '', '\n'.join(sheets), flags=re.S)

    out, n_font, n_height = [], 0, 0
    for sel, body, media in split_rules(css):
        sel = ' '.join(sel.split())
        if not sel or sel.startswith('@') or re.fullmatch(r'(from|to|[\d.]+%)', sel):
            continue
        decls = convert(sel, body)
        if not decls: continue
        n_font   += sum(1 for d in decls if d.startswith('font-size'))
        n_height += sum(1 for d in decls if d.startswith('height:auto'))
        rule = '%s{%s}' % (sel, ';'.join(decls))
        out.append('%s{%s}' % (media, rule) if media else rule)

    OUT.parent.mkdir(exist_ok=True)
    header = ('/* 由 gen-type.py 从页面自带样式自动生成，请勿手改。\n'
              '   手工微调写在 gis-light.css（注入顺序在本表之后，因而始终取胜）。*/\n')
    OUT.write_text(header + '\n'.join(out) + '\n', encoding='utf-8')
    print('放大 %d 处字号，放开 %d 个写死高度 -> %s (%d KB)'
          % (n_font, n_height, OUT, len(OUT.read_text(encoding='utf-8')) // 1024))

if __name__ == '__main__':
    main(sys.argv[1])
