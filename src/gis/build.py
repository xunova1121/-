#!/usr/bin/env python3
"""把新的 GIS 样式与脚本注入到 V10.6 离线单页中（替换旧的 real-gis 区块）。"""
import re, sys, pathlib

BASE = pathlib.Path(__file__).parent
SRC  = sys.argv[1]
DST  = sys.argv[2]

css = (BASE/'gis.css').read_text(encoding='utf-8') + '\n' \
    + (BASE/'gis-radar.css').read_text(encoding='utf-8')
js  = '\n'.join((BASE/f).read_text(encoding='utf-8')
                for f in ('gis-data.js','gis-core.js','gis-layers.js',
                          'gis-radar.js','gis-mount.js'))
# 双光通道画面：由 gen-channels.py 从页面内嵌实拍图预处理而来
vis   = (BASE/'assets'/'vis.b64').read_text(encoding='utf-8').strip()
therm = (BASE/'assets'/'therm.b64').read_text(encoding='utf-8').strip()
js = ('var VIS_B64="%s";\nvar THERM_B64="%s";\n' % (vis, therm)) + js

block = (
    '<style id="fishery-gis-style">\n' + css.rstrip() + '\n</style>\n'
    '<script id="fishery-gis-script">\n(function(){\n'
    '"use strict";\n' + js.rstrip() + '\n})();\n</script>'
)

html = pathlib.Path(SRC).read_text(encoding='utf-8')

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
