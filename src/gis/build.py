#!/usr/bin/env python3
"""把新的 GIS 样式与脚本注入到 V10.6 离线单页中（替换旧的 real-gis 区块）。"""
import re, sys, pathlib

BASE = pathlib.Path(__file__).parent
SRC  = sys.argv[1]
DST  = sys.argv[2]
# --keep-map：保留页面自带的一张图覆盖层，只追加雷达态势视图
KEEP = '--keep-map' in sys.argv[3:]

css = (BASE/'gis.css').read_text(encoding='utf-8') + '\n' \
    + (BASE/'gis-radar.css').read_text(encoding='utf-8')
js  = '\n'.join((BASE/f).read_text(encoding='utf-8')
                for f in ('gis-data.js','gis-core.js','gis-layers.js',
                          'gis-radar.js','gis-mount.js'))
# 双光通道画面：由 gen-channels.py 从页面内嵌实拍图预处理而来
vis   = (BASE/'assets'/'vis.b64').read_text(encoding='utf-8').strip()
therm = (BASE/'assets'/'therm.b64').read_text(encoding='utf-8').strip()
js = ('var VIS_B64="%s";\nvar THERM_B64="%s";\n' % (vis, therm)) + js

if KEEP:
    css = (BASE/'gis-radar.css').read_text(encoding='utf-8')
    js  = '\n'.join((BASE/f).read_text(encoding='utf-8')
                    for f in ('gis-radar.js','gis-radar-mount.js'))
    js  = ('var VIS_B64="%s";\nvar THERM_B64="%s";\n' % (vis, therm)) + js
    sid, jid = 'fishery-radar-style', 'fishery-radar-script'
else:
    sid, jid = 'fishery-gis-style', 'fishery-gis-script'

# 平台一张图：与地图模式无关，两种构建都带上。
# 它中部的 GIS 复用重制版地图的投影与图层，keep-map 模式下也要把这几支带进来。
if KEEP:
    css += '\n' + (BASE/'gis.css').read_text(encoding='utf-8')
    js  += '\n' + '\n'.join((BASE/f).read_text(encoding='utf-8')
                             for f in ('gis-data.js','gis-core.js','gis-layers.js'))
shots = {k: (BASE/'assets'/('shot_%s.b64' % k)).read_text(encoding='utf-8').strip()
         for k in ('watch','collide','enforce','board')}
js += '\nvar SHOT_B64={' + ','.join('"%s":"%s"' % (k, v) for k, v in shots.items()) + '};'
css += '\n' + (BASE/'gis-onemap.css').read_text(encoding='utf-8')
js  += '\n' + (BASE/'gis-onemap.js').read_text(encoding='utf-8')

block = (
    '<style id="%s">\n' % sid + css.rstrip() + '\n</style>\n'
    '<script id="%s">\n(function(){\n' % jid +
    '"use strict";\n' + js.rstrip() + '\n})();\n</script>'
)

html = pathlib.Path(SRC).read_text(encoding='utf-8')

if KEEP:
    # 只替换自己写过的雷达区块，页面自带的 v10x 覆盖层原样保留
    pat = re.compile(r'<style id="fishery-radar-style">.*?</script>(?=\s*</body>)', re.S)
else:
    # 认三种 id：V10.5 / V10.6 自带的覆盖层，以及本脚本自己写过的
    pat = re.compile(
        r'<style id="(?:v10\d-real-gis-style|fishery-gis-style)">.*?</script>(?=\s*</body>)',
        re.S)
if pat.search(html):
    html = pat.sub(lambda m: block, html, count=1)
else:                                   # 首次注入
    assert '</body>' in html
    html = html.replace('</body>', block + '</body>', 1)

pathlib.Path(DST).write_text(html, encoding='utf-8')
print('wrote', DST, len(html), 'chars')
