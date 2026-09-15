#!/usr/bin/env python3
"""把新的 GIS 样式与脚本注入到 V10.6 离线单页中（替换旧的 real-gis 区块）。"""
import re, sys, pathlib

BASE = pathlib.Path(__file__).parent
SRC  = sys.argv[1]
DST  = sys.argv[2]
# --keep-map：保留页面自带的一张图覆盖层，只追加雷达态势视图
KEEP = '--keep-map' in sys.argv[3:]
# --onemap：额外加一层「平台一张图」总览首屏。默认不加——用户要的是他自己的 demo，
# 不是我另做一块首页。
ONEMAP = '--onemap' in sys.argv[3:]

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

# 平台一张图：可选。它中部的 GIS 复用重制版地图的投影与图层，
# keep-map 模式下要把这几支一并带进来。
if ONEMAP:
    if KEEP:
        css += '\n' + (BASE/'gis.css').read_text(encoding='utf-8')
        js  += '\n' + '\n'.join((BASE/f).read_text(encoding='utf-8')
                                 for f in ('gis-data.js','gis-core.js','gis-layers.js'))
    shots = {k: (BASE/'assets'/('shot_%s.b64' % k)).read_text(encoding='utf-8').strip()
             for k in ('watch','collide','enforce','board')}
    js += '\nvar SHOT_B64={' + ','.join('"%s":"%s"' % (k, v) for k, v in shots.items()) + '};'
    # 一张图中部底图：放了 assets/map.b64 就用它，否则回落到内置矢量图
    _map = BASE / 'assets' / 'map.b64'
    js += '\nvar MAP_IMG_B64="%s";' % (_map.read_text(encoding='utf-8').strip() if _map.exists() else '')
    css += '\n' + (BASE/'gis-onemap.css').read_text(encoding='utf-8')
# 浅色主题：先按**当前底稿**自动生成映射表，再叠手写微调（后者靠文档顺序取胜）。
# 必须每次重算——不同底稿的深色表不一样，复用上一次的会串色。
import subprocess
subprocess.run([sys.executable, str(BASE/'gen-light.py'), SRC], check=True,
               stdout=subprocess.DEVNULL)
subprocess.run([sys.executable, str(BASE/'gen-type.py'), SRC], check=True,
               stdout=subprocess.DEVNULL)
for _gen in ('light-auto.css', 'type-auto.css'):
    _f = BASE/'assets'/_gen
    if _f.exists():
        css += '\n' + _f.read_text(encoding='utf-8')
css += '\n' + (BASE/'gis-light.css').read_text(encoding='utf-8')

# 雷达态势是一块「屏」，整块留深色。但 gis-light.css 里那条
# 「.shell :is(span,small,p,...) 统一压成深墨色 !important」会一路压进去，
# 把 rd- 面板里的浅色小字变成深底深字（目标信息、系统状态那几块就是这么瞎的）。
# 这里把 gis-radar.css 自己的 color 声明按原样重申一遍，前面加 .shell 抬特指度。
# 好处是跟着 gis-radar.css 走，改配色不用两头同步。
import importlib.util as _ilu
_spec = _ilu.spec_from_file_location('gen_type', BASE/'gen-type.py')
_gt = _ilu.module_from_spec(_spec); _spec.loader.exec_module(_gt)
_scale_font = _gt.scale_font

_RD_SKIP = ('.rd-card-x', '.rd-wind-chip')   # 这两个挂在浅色一张图上，不能跟着回深
def _reassert_radar(radar_css):
    import re as _re
    src = _re.sub(r'/\*.*?\*/', '', radar_css, flags=_re.S)
    out = []
    for sel, body in _re.findall(r'([^{}]+)\{([^}]*)\}', src):
        sel = ' '.join(sel.split())
        if not sel.startswith('.rd-') or any(k in sel for k in _RD_SKIP):
            continue
        decls = []
        m = _re.search(r'(?:^|;)\s*color\s*:\s*([^;]+)', body)
        if m:
            decls.append('color:%s!important' % m.group(1).strip())
        # 雷达面板自己的字号是 8~10px，比页面正文还小。gen-type.py 只读页面自带的
        # 样式表，管不到这支，所以在这里套同一张档位表，两边保持一致。
        m = _re.search(r'(?:^|;)\s*font-size\s*:\s*([\d.]+)px', body)
        if m:
            decls.append('font-size:%gpx!important' % _scale_font(float(m.group(1))))
        if not decls:
            continue
        parts = [' '.join(x.split()) for x in sel.split(',')]
        out.append(','.join('.shell ' + x for x in parts) + '{%s}' % ';'.join(decls))
    return '\n'.join(out)
css += ('\n/* ---- 雷达视图配色重申（自 gis-radar.css 生成） ---- */\n'
        + _reassert_radar((BASE/'gis-radar.css').read_text(encoding='utf-8')))
if ONEMAP:
    js += '\n' + (BASE/'gis-onemap.js').read_text(encoding='utf-8')

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
