/**
 * PPT 模板配图：手写的原创几何插画（SVG，1600×900），按模板配色上色。
 * 生成样张时由 scripts/make-ppt-templates.mjs 栅格化；App 里选了模板时在设备上用画布画成 PNG 放进工作区（不打包图片文件）。
 * 只用简单图形（矩形、圆、路径），不引用外部图片或字体。
 */
const W = 1600, H = 900;
const hex = (c) => `#${String(c).replace('#', '')}`;
/** 把颜色往白色混一点（0–1） */
function tint(c, k) {
  const n = parseInt(String(c).replace('#', ''), 16);
  const mix = (v) => Math.round(v + (255 - v) * k).toString(16).padStart(2, '0');
  return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
}
const wrap = (c, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${tint(c.soft, 0.2)}"/><stop offset="1" stop-color="${tint(c.accent, 0.78)}"/></linearGradient>
<linearGradient id="main" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hex(c.accent)}"/><stop offset="1" stop-color="${hex(c.primary)}"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>${body}</svg>`;

/** 伪随机：同一模板每次画出来一样 */
function rng(seed) { let s = seed; return () => (s = (s * 9301 + 49297) % 233280) / 233280; }

const MOTIFS = {
  city(c) {
    const r = rng(7); let x = 80, out = '';
    while (x < W - 80) {
      const w = 90 + r() * 110, h = 220 + r() * 430, y = 780 - h, col = r() > 0.5 ? 'url(#main)' : tint(c.primary, 0.25 + r() * 0.3);
      out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${col}"/>`;
      for (let wy = y + 30; wy < 760; wy += 46) for (let wx = x + 18; wx < x + w - 24; wx += 34) if (r() > 0.35) out += `<rect x="${wx}" y="${wy}" width="16" height="22" rx="2" fill="${tint(c.soft, 0.1)}" opacity="${0.45 + r() * 0.5}"/>`;
      x += w + 14;
    }
    return `<circle cx="1260" cy="210" r="110" fill="${hex(c.extra)}" opacity=".85"/><path d="M0 640 C 400 560 800 700 1600 600 L1600 900 L0 900Z" fill="${tint(c.accent, 0.55)}" opacity=".6"/>${out}<rect y="780" width="${W}" height="120" fill="${hex(c.primary)}"/><path d="M0 800 H1600" stroke="${tint(c.soft, 0.2)}" stroke-width="6" stroke-dasharray="60 40"/>`;
  },
  dashboard(c) {
    const bars = [0.45, 0.62, 0.55, 0.78, 0.7, 0.92].map((v, i) => `<rect x="${330 + i * 78}" y="${640 - v * 300}" width="48" height="${v * 300}" rx="8" fill="${i === 5 ? hex(c.extra) : 'url(#main)'}"/>`).join('');
    return `<rect x="240" y="120" width="1120" height="660" rx="36" fill="${tint(c.soft, 0.5)}" stroke="${hex(c.primary)}" stroke-width="14"/><rect x="700" y="780" width="200" height="60" fill="${hex(c.primary)}"/><rect x="580" y="830" width="440" height="30" rx="15" fill="${hex(c.primary)}"/>
${bars}<path d="M330 330 L470 300 L610 340 L750 250" fill="none" stroke="${hex(c.accent)}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="1080" cy="330" r="130" fill="none" stroke="${tint(c.accent, 0.6)}" stroke-width="46"/><circle cx="1080" cy="330" r="130" fill="none" stroke="${hex(c.accent)}" stroke-width="46" stroke-dasharray="560 900" transform="rotate(-90 1080 330)"/>
<rect x="900" y="520" width="360" height="26" rx="13" fill="${tint(c.primary, 0.6)}"/><rect x="900" y="570" width="280" height="26" rx="13" fill="${tint(c.primary, 0.7)}"/><rect x="900" y="620" width="320" height="26" rx="13" fill="${hex(c.extra)}" opacity=".8"/>`;
  },
  ribbon(c) {
    return `<path d="M-100 620 C 300 420 600 760 1000 520 S 1500 380 1750 480 L1750 900 L-100 900Z" fill="url(#main)"/><path d="M-100 700 C 320 520 640 820 1040 600 S 1500 480 1750 560" fill="none" stroke="${hex(c.extra)}" stroke-width="26" opacity=".9"/>
<path d="M-100 760 C 340 600 680 860 1080 670 S 1520 560 1750 640" fill="none" stroke="${tint(c.extra, 0.4)}" stroke-width="12" opacity=".8"/>
${[[1180, 180, 70], [1330, 280, 34], [1080, 300, 30], [1250, 380, 26], [1420, 160, 22]].map(([x, y, s]) => `<path d="M${x} ${y - s} L${x + s * 0.29} ${y - s * 0.4} L${x + s * 0.95} ${y - s * 0.31} L${x + s * 0.47} ${y + s * 0.15} L${x + s * 0.59} ${y + s * 0.81} L${x} ${y + s * 0.5} L${x - s * 0.59} ${y + s * 0.81} L${x - s * 0.47} ${y + s * 0.15} L${x - s * 0.95} ${y - s * 0.31} L${x - s * 0.29} ${y - s * 0.4}Z" fill="${hex(c.extra)}"/>`).join('')}`;
  },
  leaves(c) {
    const r = rng(11); let trees = '';
    for (let i = 0; i < 9; i++) { const x = 120 + i * 175 + r() * 40, h = 120 + r() * 120, y = 640 - r() * 60; trees += `<rect x="${x - 7}" y="${y - h * 0.2}" width="14" height="${h * 0.6}" fill="${tint(c.primary, 0.2)}"/><circle cx="${x}" cy="${y - h * 0.45}" r="${50 + r() * 40}" fill="${r() > 0.5 ? hex(c.accent) : tint(c.accent, 0.3)}"/>`; }
    return `<circle cx="1300" cy="200" r="100" fill="${hex(c.extra)}" opacity=".25"/><circle cx="1300" cy="200" r="64" fill="#ffd77a"/><path d="M0 560 C 300 470 600 560 900 500 S 1400 460 1600 520 L1600 900 L0 900Z" fill="${tint(c.accent, 0.55)}"/>
${trees}<path d="M0 700 C 400 620 900 760 1600 660 L1600 900 L0 900Z" fill="url(#main)"/><path d="M200 900 C 500 760 800 760 1100 900" fill="none" stroke="${tint(c.soft, 0.3)}" stroke-width="28" opacity=".7"/>`;
  },
  growth(c) {
    const bars = [0.3, 0.42, 0.55, 0.7, 0.86].map((v, i) => `<rect x="${260 + i * 210}" y="${760 - v * 560}" width="140" height="${v * 560}" rx="14" fill="${i === 4 ? 'url(#main)' : tint(c.primary, 0.55 - i * 0.08)}"/>`).join('');
    return `${bars}<path d="M260 600 L520 520 L760 450 L1000 330 L1300 170" fill="none" stroke="${hex(c.extra)}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/><path d="M1300 170 l-70 6 m70 -6 l-30 62" stroke="${hex(c.extra)}" stroke-width="16" stroke-linecap="round" fill="none"/>
<rect x="200" y="770" width="1240" height="10" rx="5" fill="${hex(c.primary)}"/>${[0, 1, 2].map((i) => `<circle cx="${1380 - i * 30}" cy="${700 - i * 46}" r="44" fill="${hex(c.extra)}" opacity="${0.6 + i * 0.15}"/>`).join('')}`;
  },
  orbit(c) {
    const r = rng(5); let stars = '';
    for (let i = 0; i < 70; i++) stars += `<circle cx="${r() * W}" cy="${r() * H}" r="${1 + r() * 3}" fill="#ffffff" opacity="${0.3 + r() * 0.6}"/>`;
    return `<rect width="${W}" height="${H}" fill="${hex(c.primary)}"/>${stars}<circle cx="1100" cy="470" r="230" fill="url(#main)"/><ellipse cx="1100" cy="470" rx="380" ry="90" fill="none" stroke="${hex(c.extra)}" stroke-width="14" transform="rotate(-18 1100 470)"/>
<circle cx="1360" cy="210" r="40" fill="${tint(c.extra, 0.3)}"/><path d="M300 700 L420 580 M380 560 l70 -10 l-10 70 Z" stroke="${hex(c.extra)}" stroke-width="10" fill="${hex(c.extra)}" stroke-linejoin="round"/><path d="M200 800 C 400 760 500 660 640 600" fill="none" stroke="${tint(c.accent, 0.5)}" stroke-width="6" stroke-dasharray="14 18"/>`;
  },
  books(c) {
    const cols = [hex(c.primary), hex(c.accent), tint(c.primary, 0.45), hex(c.extra), tint(c.accent, 0.4)];
    const stack = cols.map((col, i) => `<rect x="${430 + (i % 2) * 30}" y="${720 - (i + 1) * 78}" width="${560 - i * 30}" height="68" rx="10" fill="${col}"/><rect x="${470 + (i % 2) * 30}" y="${740 - (i + 1) * 78}" width="${200}" height="10" rx="5" fill="#ffffff" opacity=".55"/>`).join('');
    return `<rect x="200" y="720" width="1200" height="24" rx="12" fill="${hex(c.primary)}"/>${stack}<path d="M1150 720 V420 M1150 420 L1040 330 H1260 Z" stroke="${hex(c.primary)}" stroke-width="14" fill="${tint(c.extra, 0.3)}" stroke-linejoin="round"/>
<circle cx="1150" cy="440" r="160" fill="#ffe9a8" opacity=".35"/><path d="M1320 720 C 1300 620 1360 560 1400 520 M1320 720 C 1330 640 1280 600 1250 580" stroke="${hex(c.accent)}" stroke-width="12" fill="none" stroke-linecap="round"/><circle cx="1400" cy="510" r="34" fill="${hex(c.accent)}"/><circle cx="1245" cy="572" r="26" fill="${tint(c.accent, 0.3)}"/>`;
  },
  device(c) {
    return `<circle cx="800" cy="450" r="360" fill="${tint(c.accent, 0.7)}" opacity=".6"/><circle cx="800" cy="450" r="250" fill="${tint(c.extra, 0.6)}" opacity=".5"/>
<rect x="430" y="230" width="740" height="460" rx="30" fill="${hex(c.primary)}"/><rect x="460" y="260" width="680" height="400" rx="14" fill="url(#main)"/><rect x="340" y="690" width="920" height="36" rx="18" fill="${tint(c.primary, 0.3)}"/>
<rect x="1180" y="330" width="170" height="320" rx="28" fill="${hex(c.primary)}"/><rect x="1196" y="356" width="138" height="270" rx="14" fill="${hex(c.extra)}"/>
<rect x="510" y="320" width="300" height="34" rx="17" fill="#ffffff" opacity=".85"/><rect x="510" y="380" width="220" height="22" rx="11" fill="#ffffff" opacity=".5"/><circle cx="980" cy="470" r="90" fill="#ffffff" opacity=".22"/><path d="M945 470 l28 28 l52 -60" stroke="#ffffff" stroke-width="16" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  },
  lanterns(c) {
    const r = rng(3); let confetti = '';
    for (let i = 0; i < 40; i++) confetti += `<rect x="${r() * W}" y="${r() * H}" width="${10 + r() * 14}" height="${6 + r() * 8}" rx="3" fill="${[hex(c.accent), hex(c.extra), tint(c.primary, 0.3)][i % 3]}" transform="rotate(${r() * 90} ${r() * W} ${r() * H})" opacity=".8"/>`;
    const lantern = (x, y, s) => `<path d="M${x} 0 V${y - s}" stroke="${hex(c.primary)}" stroke-width="4"/><rect x="${x - s * 0.35}" y="${y - s * 1.05}" width="${s * 0.7}" height="${s * 0.16}" rx="4" fill="${hex(c.extra)}"/><ellipse cx="${x}" cy="${y}" rx="${s * 0.75}" ry="${s * 0.9}" fill="${hex(c.accent)}"/><path d="M${x} ${y - s * 0.9} V${y + s * 0.9} M${x - s * 0.4} ${y - s * 0.78} C ${x - s * 0.6} ${y} ${x - s * 0.6} ${y} ${x - s * 0.4} ${y + s * 0.78} M${x + s * 0.4} ${y - s * 0.78} C ${x + s * 0.6} ${y} ${x + s * 0.6} ${y} ${x + s * 0.4} ${y + s * 0.78}" stroke="${tint(c.accent, 0.35)}" stroke-width="4" fill="none"/><rect x="${x - s * 0.35}" y="${y + s * 0.88}" width="${s * 0.7}" height="${s * 0.16}" rx="4" fill="${hex(c.extra)}"/><path d="M${x} ${y + s * 1.04} v${s * 0.5}" stroke="${hex(c.extra)}" stroke-width="8" stroke-linecap="round"/>`;
    return `${confetti}${lantern(330, 330, 150)}${lantern(620, 230, 110)}${lantern(1000, 300, 130)}${lantern(1300, 220, 100)}<path d="M0 760 C 400 700 1200 820 1600 740 L1600 900 L0 900Z" fill="url(#main)"/>`;
  },
  glass(c) {
    // 玻璃质感的流体团：几层半透明渐变圆叠加（配色自定，构图原创）
    const blob = (cx, cy, r, from, to, o) => `<defs><radialGradient id="g${cx}${cy}" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#ffffff" stop-opacity=".9"/><stop offset=".45" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></radialGradient></defs><circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#g${cx}${cy})" opacity="${o}"/>`;
    return `${blob(1120, 360, 300, tint(c.accent, 0.35), hex(c.primary), 0.92)}${blob(1380, 640, 150, tint(c.extra, 0.3), hex(c.extra), 0.85)}${blob(820, 650, 110, tint(c.accent, 0.6), hex(c.accent), 0.8)}${blob(1460, 180, 70, '#ffffff', tint(c.accent, 0.4), 0.9)}
<path d="M760 420 C 900 200 1300 160 1480 360 S 1300 760 980 700" fill="none" stroke="#ffffff" stroke-width="10" opacity=".55" stroke-linecap="round"/><rect x="120" y="680" width="420" height="16" rx="8" fill="${hex(c.accent)}" opacity=".5"/><rect x="120" y="720" width="280" height="16" rx="8" fill="${hex(c.extra)}" opacity=".5"/>`;
  },
  campus(c) {
    const cols = Array.from({ length: 7 }, (_, i) => `<rect x="${560 + i * 80}" y="360" width="40" height="300" rx="6" fill="${tint(c.soft, 0.3)}"/>`).join('');
    return `<circle cx="1320" cy="200" r="80" fill="${hex(c.extra)}" opacity=".18"/><rect x="500" y="320" width="600" height="360" fill="url(#main)"/><path d="M460 330 L800 160 L1140 330 Z" fill="${hex(c.primary)}"/><circle cx="800" cy="260" r="38" fill="${tint(c.soft, 0.4)}"/>${cols}
<rect x="440" y="660" width="720" height="40" fill="${hex(c.primary)}"/><rect x="400" y="700" width="800" height="30" fill="${tint(c.primary, 0.3)}"/><path d="M0 760 C 400 720 1200 800 1600 740 L1600 900 L0 900Z" fill="${tint(c.accent, 0.5)}"/>
<path d="M1260 700 V560 M1260 560 l-50 40 M1260 590 l50 -40" stroke="${hex(c.primary)}" stroke-width="10" stroke-linecap="round"/><circle cx="1260" cy="520" r="70" fill="${tint(c.accent, 0.2)}"/><circle cx="300" cy="560" r="90" fill="${tint(c.accent, 0.3)}"/><rect x="292" y="600" width="16" height="110" fill="${hex(c.primary)}"/>`;
  },
  timeline(c) {
    const pts = [[260, 520], [520, 470], [780, 600], [1040, 380], [1300, 430]];
    const nodes = pts.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i === 2 ? 46 : 30}" fill="${i === 2 ? hex(c.extra) : 'url(#main)'}"/><rect x="${x - 70}" y="${y + 70}" width="140" height="18" rx="9" fill="${tint(c.primary, 0.55)}"/><rect x="${x - 50}" y="${y + 100}" width="100" height="14" rx="7" fill="${tint(c.primary, 0.7)}"/>`).join('');
    return `<path d="M200 ${pts[0][1]} ${pts.map(([x, y]) => `L${x} ${y}`).join(' ')} L1420 430" fill="none" stroke="${hex(c.primary)}" stroke-width="12" stroke-linejoin="round"/>${nodes}
<path d="M780 600 m-14 -18 h28 l-14 -26z" fill="#ffffff"/><rect x="772" y="590" width="16" height="16" rx="3" fill="#ffffff"/><rect x="200" y="760" width="1220" height="8" rx="4" fill="${tint(c.primary, 0.5)}"/>
${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${200 + i * 244}" y="748" width="4" height="32" fill="${hex(c.primary)}"/>`).join('')}`;
  },
  circuit(c) {
    const r = rng(9); let lines = '';
    for (let i = 0; i < 14; i++) { const y = 140 + i * 48, x1 = 120 + r() * 300, x2 = x1 + 200 + r() * 500, bend = y + (r() > 0.5 ? 40 : -40); lines += `<path d="M${x1} ${y} H${x2} L${x2 + 40} ${bend} H${x2 + 160}" fill="none" stroke="${i % 3 ? tint(c.accent, 0.4) : hex(c.extra)}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${x2 + 166}" cy="${bend}" r="10" fill="${hex(c.accent)}"/>`; }
    return `<rect width="${W}" height="${H}" fill="${hex(c.primary)}"/>${lines}<rect x="1060" y="270" width="360" height="360" rx="40" fill="url(#main)" stroke="${hex(c.extra)}" stroke-width="10"/><rect x="1140" y="350" width="200" height="200" rx="24" fill="${hex(c.primary)}"/>
${[0, 1, 2, 3].map((i) => `<rect x="${1090 + i * 90}" y="230" width="14" height="40" rx="5" fill="${hex(c.extra)}"/><rect x="${1090 + i * 90}" y="630" width="14" height="40" rx="5" fill="${hex(c.extra)}"/>`).join('')}<path d="M1200 450 l30 30 l60 -70" stroke="${hex(c.extra)}" stroke-width="16" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  },
  compass(c) {
    return `<circle cx="1040" cy="450" r="300" fill="${tint(c.soft, 0.4)}" stroke="${hex(c.primary)}" stroke-width="14"/><circle cx="1040" cy="450" r="240" fill="none" stroke="${tint(c.primary, 0.6)}" stroke-width="4" stroke-dasharray="8 22"/>
<path d="M1040 230 L1090 450 L1040 670 L990 450 Z" fill="${tint(c.primary, 0.55)}"/><path d="M1040 230 L1090 450 L990 450 Z" fill="${hex(c.extra)}"/><circle cx="1040" cy="450" r="26" fill="${hex(c.primary)}"/>
${['N', 'E', 'S', 'W'].map((_, i) => { const a = (i * Math.PI) / 2, x = 1040 + Math.sin(a) * 270, y = 450 - Math.cos(a) * 270; return `<circle cx="${x}" cy="${y}" r="14" fill="${hex(c.primary)}"/>`; }).join('')}
<rect x="180" y="300" width="480" height="70" rx="16" fill="url(#main)"/><rect x="180" y="410" width="380" height="50" rx="12" fill="${tint(c.primary, 0.55)}"/><rect x="180" y="490" width="420" height="50" rx="12" fill="${tint(c.primary, 0.65)}"/><rect x="180" y="570" width="300" height="50" rx="12" fill="${tint(c.primary, 0.75)}"/>`;
  },
  mountains(c) {
    return `<circle cx="1180" cy="230" r="90" fill="#ffffff" opacity=".9"/><path d="M0 700 L320 330 L560 560 L820 260 L1180 640 L1400 420 L1600 600 L1600 900 L0 900Z" fill="${tint(c.primary, 0.55)}"/>
<path d="M820 260 L900 345 L860 360 L820 330 L780 360 L760 330Z" fill="#ffffff" opacity=".85"/><path d="M0 780 L420 520 L700 720 L1000 480 L1600 760 L1600 900 L0 900Z" fill="url(#main)"/><path d="M0 860 C 500 800 1100 900 1600 840 L1600 900 L0 900Z" fill="${hex(c.primary)}"/>`;
  }
};

export const ART_MOTIFS = Object.keys(MOTIFS);
export function artSvg(motif, colors) {
  const draw = MOTIFS[motif];
  if (!draw) throw new Error(`没有这个配图图案：${motif}`);
  return wrap(colors, draw(colors));
}
