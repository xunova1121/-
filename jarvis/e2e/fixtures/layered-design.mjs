/** 人工撰写的版式样例；新闻/业务均为演示，不混入用户资料或虚构实时事实。 */
export const newsInput = {
  title: '城市，向美好生长', subtitle: '七个切面，读懂生活的新可能', width: 1080, height: 1920,
  footer: '未央设计样例 · 非真实新闻 · 2026.11.15',
  design: { layout: 'editorial', eyebrow: 'WEIYANG / 城市观察', sections: [
    { title: '让城市，在绿色中生长', eyebrow: '本期关注', icon: 'leaf', category: '城市', body: '从一座公园到一片街区，观察人与自然共生的新可能。', detail: '此条为编辑版式演示文案，不对应实际新闻报道。' },
    { title: '创新，走进日常', icon: 'chart', category: '科技', body: '用更轻盈的技术，让复杂的事情变得简单。' },
    { title: '阅读让街角发光', icon: 'news', category: '文化', body: '一间书屋，连接一座城市的精神生活。' },
    { title: '把时间留给生活', icon: 'calendar', category: '生活', body: '在忙碌与松弛之间，找到自己的节奏。' },
    { title: '新空间，新相遇', icon: 'building', category: '城市', body: '旧街区更新，也让熟悉的故事继续。' },
    { title: '每一份热爱都有回响', icon: 'heart', category: '文化', body: '小小的坚持，是平凡日子里的光。' },
    { title: '为明天留一点想象', icon: 'star', category: '生活', body: '从今天的一个选择，开启未来的可能。' }
  ] }
};
const days = (date, target) => String(Math.ceil((Date.parse(target + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86400000));
export const babyInput = {
  title: '慢慢长大，慢慢相见', subtitle: '把等待的每一天，都过成温柔的纪念', width: 1080, height: 1920,
  footer: '日期与数值仅为界面演示 · 不构成孕期建议', dataMode: 'demo', asOf: '演示日期 2026-11-15',
  design: { layout: 'celebration', eyebrow: 'A LITTLE MIRACLE / 温柔倒计时', assets: [{ id: 'hero', path: '分层验收/assets/baby.png' }], sections: [
    { title: '距离见面还有', value: days('2026-11-15', '2027-04-01'), unit: '天', category: '纪念', detail: '以演示日期2026-11-15到演示目标日2027-04-01的UTC日历差计算；不推断孕周或健康状态。' },
    { title: '值得珍藏的日子', value: '04.01', category: '纪念', detail: '2027-04-01，仅是用户可编辑的演示目标日期。' },
    { title: '今天的小期待', value: '慢一点', category: '心情', detail: '给今天一个拥抱，给明天留一点期待。' },
    { title: '给未来的礼物', value: '写封信', category: '心情', detail: '记录此刻的心情，等相见时一起读。' }
  ], states: [{ label: '演示下一日 · 11月16日', changes: [{ id: 'section-1-value', text: days('2026-11-16', '2027-04-01') + '天' }] }] }
};
export const dashboardInput = {
  title: '城市运行 · 一屏掌握', subtitle: '用清楚的数据，看见城市的每一次变化', width: 3840, height: 2160,
  footer: '演示数据 / 非实时业务 · 主视觉为抽象意象，未绘制地理边界',
  design: { layout: 'dashboard', assets: [{ id: 'hero', path: '分层验收/assets/planet.png' }], sections: [
    { title: '服务站点', value: '128', unit: '个', icon: 'building', category: '服务', detail: '演示值，未连接业务后台。' },
    { title: '今日受理', value: '3,860', unit: '件', icon: 'news', category: '业务' },
    { title: '按时完成', value: '98.6', unit: '%', icon: 'check', category: '业务' },
    { title: '运行状态', value: '平稳', icon: 'leaf', category: '服务' },
    { title: '服务趋势 · 近六日', category: '趋势', detail: '单位：百件。仅演示离线快照切换与数据详情，不代表真实业务量。', points: [
      { label: '11.10', value: 24 }, { label: '11.11', value: 31 }, { label: '11.12', value: 28 }, { label: '11.13', value: 36 }, { label: '11.14', value: 32 }, { label: '11.15', value: 39 }
    ] }
  ], states: [{ label: '历史快照 · 11月14日', changes: [
    { id: 'section-2-value', text: '3,210件' }, { id: 'section-3-value', text: '97.8%' },
    { id: 'section-5-chart', points: [{ label: '11.09', value: 21 }, { label: '11.10', value: 24 }, { label: '11.11', value: 31 }, { label: '11.12', value: 28 }, { label: '11.13', value: 36 }, { label: '11.14', value: 32 }] }
  ] }] }
};

/** 夹具原创矢量插画由浏览器实际栅格化；不冒充真实GPT接口调用。 */
export const sampleArt = {
  baby: `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#F8E9DE"/><stop offset="1" stop-color="#F7D2C8"/></linearGradient><radialGradient id="moon"><stop stop-color="#FFFAE5"/><stop offset="1" stop-color="#EDC796"/></radialGradient><filter id="shadow"><feDropShadow dx="0" dy="24" stdDeviation="24" flood-color="#A97C69" flood-opacity=".2"/></filter><radialGradient id="bear"><stop stop-color="#FAF5E7"/><stop offset="1" stop-color="#D1BDA1"/></radialGradient></defs><rect width="1600" height="1000" fill="url(#bg)"/><ellipse cx="800" cy="848" rx="520" ry="70" fill="#E7C0AF" opacity=".35"/><g fill="#FFF6E8" opacity=".8"><circle cx="250" cy="220" r="11"/><circle cx="1260" cy="160" r="8"/><circle cx="1390" cy="480" r="12"/><path d="M360 420l12 28 30 9-30 10-12 28-12-28-30-10 30-9Z"/><path d="M1190 350l10 23 24 8-24 8-10 22-9-22-25-8 25-8Z"/></g><g filter="url(#shadow)"><circle cx="800" cy="478" r="308" fill="url(#moon)"/><circle cx="922" cy="370" r="262" fill="#F5DACE"/></g><g filter="url(#shadow)"><ellipse cx="815" cy="697" rx="200" ry="140" fill="url(#bear)"/><circle cx="662" cy="499" r="75" fill="#D4C0A4"/><circle cx="899" cy="488" r="75" fill="#D4C0A4"/><circle cx="666" cy="502" r="45" fill="#F2D2C1"/><circle cx="897" cy="491" r="45" fill="#F2D2C1"/><ellipse cx="790" cy="575" rx="175" ry="148" fill="url(#bear)"/><ellipse cx="787" cy="632" rx="83" ry="62" fill="#FFF8EB"/><ellipse cx="788" cy="612" rx="21" ry="15" fill="#73574D"/><path d="M691 573q24 26 48 0M839 573q24 26 48 0M788 626v16m0-2q-16 14-29 0m29 0q16 14 29 0" fill="none" stroke="#73574D" stroke-width="10" stroke-linecap="round"/><ellipse cx="649" cy="742" rx="83" ry="57" fill="url(#bear)"/><ellipse cx="977" cy="741" rx="83" ry="57" fill="url(#bear)"/><path d="M726 709q65 45 130 0l-65 68Z" fill="#B36970"/></g><g fill="#FFFBF1"><ellipse cx="373" cy="781" rx="128" ry="44"/><circle cx="320" cy="752" r="45"/><circle cx="381" cy="737" r="60"/><ellipse cx="1208" cy="767" rx="141" ry="48"/><circle cx="1172" cy="724" r="55"/><circle cx="1238" cy="720" r="62"/></g></svg>`,
  planet: `<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="864" viewBox="0 0 1536 864"><defs><radialGradient id="space"><stop stop-color="#14566E"/><stop offset="1" stop-color="#06162A"/></radialGradient><radialGradient id="planet" cx=".3" cy=".25"><stop stop-color="#2A8DAB"/><stop offset=".6" stop-color="#124561"/><stop offset="1" stop-color="#07182F"/></radialGradient><filter id="glow"><feGaussianBlur stdDeviation="9"/></filter></defs><rect width="1536" height="864" fill="url(#space)"/><g stroke="#4CCDE5" opacity=".15" fill="none">${Array.from({ length: 14 }, (_, i) => `<path d="M${i * 120} 0V864M0 ${i * 80}H1536"/>`).join('')}</g><circle cx="802" cy="446" r="320" fill="none" stroke="#51CFE9" stroke-width="8" filter="url(#glow)"/><circle cx="802" cy="446" r="306" fill="url(#planet)" stroke="#55B6D1" stroke-width="2"/><g stroke="#63D6E5" opacity=".28" fill="none"><ellipse cx="802" cy="446" rx="306" ry="120"/><ellipse cx="802" cy="446" rx="306" ry="240"/><ellipse cx="802" cy="446" rx="120" ry="306"/><ellipse cx="802" cy="446" rx="240" ry="306"/><path d="M496 446H1108M802 140V752"/></g><g fill="none" stroke="#72E5EC" stroke-linecap="round"><path d="M563 418Q780 75 1042 364M584 572Q797 219 1093 498M626 656Q785 328 1014 615" stroke-width="3" opacity=".7"/><ellipse cx="802" cy="446" rx="520" ry="180" transform="rotate(-18 802 446)" opacity=".35"/></g><g fill="#A6FFFF">${[[563,418],[1042,364],[584,572],[1093,498],[626,656],[1014,615],[693,260],[854,365],[910,540]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7"/><circle cx="${x}" cy="${y}" r="20" opacity=".12"/>`).join('')}</g><g fill="#8AC5DD" opacity=".6">${Array.from({ length: 30 }, (_, i) => `<circle cx="${(i * 179 + 37) % 1536}" cy="${(i * 137 + 57) % 864}" r="${i % 3 + 1}"/>`).join('')}</g></svg>`
};
