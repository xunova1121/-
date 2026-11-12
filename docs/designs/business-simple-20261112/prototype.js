/* 交互设计稿：全部使用明确的演示数据；不连接服务器、不调用模型、不保存用户输入。 */
const icons = {
  building:'<path d="M4 21V4h11v17M15 10h5v11M2 21h20M8 8h3M8 12h3M8 16h3M17 14h1M17 18h1"/>',
  briefcase:'<rect x="3" y="7" width="18" height="14" rx="3"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12a23 23 0 0 0 18 0M10 13v3h4v-3"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  file:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/>',
  star:'<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4-4.6-4.5 6.4-.9z"/>',
  chat:'<path d="M21 12a8 8 0 0 1-8 8H5l-3 2V12a9 9 0 1 1 19 0Z"/><path d="M7 10h9M7 14h6"/>',
  bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M9 21h6"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>', down:'<path d="m6 9 6 6 6-6"/>',
  back:'<path d="m15 5-7 7 7 7"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>',
  spark:'<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4zM20 3v4M18 5h4"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
  download:'<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  link:'<path d="m9 15 6-6M8 17l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 7l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  filter:'<path d="M4 6h16M7 12h10M10 18h4"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  speaker:'<path d="m11 4-6 5H2v6h3l6 5zM15 8a5 5 0 0 1 0 8M18 4a10 10 0 0 1 0 16"/>',
  refresh:'<path d="M20 4v6h-6M20 10A8 8 0 1 0 21 15"/>',
  send:'<path d="m12 5-7 7m7-7 7 7M12 5v15"/>',
};
const icon = name => `<svg aria-hidden="true" viewBox="0 0 24 24">${icons[name] || icons.file}</svg>`;
const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const brand = document.querySelector('.brand img').src;
const topics = { basic:'企业概况', shareholders:'股东股权', executives:'主要人员', investments:'对外投资' };
const agents = ['企业与招投标','行情查询','公文写作','PPT助手','海报设计','深度研究','图片转文字','健康顾问','出行天气'];
const agentExamples = {
  '企业与招投标':{question:'这家公司的股权情况，下一步该怎么看？',context:'当前企业',lead:'先看<strong>登记股东与出资比例</strong>，再沿着股权链核对上层股东。不要只凭法人姓名判断谁是实际控制人。',steps:['核对企业全称与信用代码，避免同名混淆。','标出资料日期与来源，未知项继续保留待核实。'],follow:['查看股东资料','核对资料来源','整理成报告']},
  '行情查询':{question:'今天大盘的情况怎么样？',context:'市场总览',lead:'行情页先展示<strong>指数、涨跌与走势图</strong>，再解释市场变化。所有数字同时保留行情时间和来源。',steps:['切换指数，查看同一交易日的数据。','区分实时行情、收盘数据和可能延迟的报价。'],follow:['查看其他指数','比较近期走势','核对行情时间']},
  '公文写作':{question:'把这些材料整理成一份工作总结。',context:'工作总结',lead:'先整理事实和结构，再进入<strong>可编辑文稿与版式预览</strong>。修改可以直接针对某一段，不必从头描述整篇要求。',steps:['在原稿中确认需要保留的事实与数字。','预览排版，逐段修改后导出Word。'],follow:['查看文稿预览','修改这一段','导出Word']},
  'PPT助手':{question:'根据这些资料制作一份项目汇报PPT。',context:'项目汇报',lead:'在工作区确认<strong>提纲、风格与逐页内容</strong>，讨论围绕当前演示文稿进行。',steps:['先检查汇报结构，再确定视觉风格。','逐页预览，修改指定页面并导出可编辑PPT。'],follow:['调整提纲','预览每一页','导出PPT']},
  '海报设计':{question:'帮我制作一张活动宣传海报。',context:'活动海报',lead:'海报工作区保留<strong>画面预览、中文文案和文字图层</strong>。改字直接修改文案，避免整张图片反复重做。',steps:['确认尺寸、标题与活动信息。','预览文字和画面，核对后保存原图与可编辑稿。'],follow:['修改海报文字','更换画面风格','保存原图']},
  '深度研究':{question:'对比两个方案，整理有来源的结论。',context:'方案研究',lead:'研究结果分为<strong>结论、证据与待核实项</strong>，可以从每个结论回到对应资料。',steps:['查看各来源的日期和适用范围。','对存在冲突的内容继续核对，再导出研究报告。'],follow:['查看证据','比较方案差异','导出研究报告']},
  '图片转文字':{question:'提取这张图片里的表格，并核对数字。',context:'原图与识别结果',lead:'原图和<strong>可编辑识别结果</strong>并排查看，存疑的字和数字单独标记。',steps:['对照原图修改存疑内容。','保留表格行列结构，确认后导出。'],follow:['回看原图','核对存疑数字','导出表格']},
  '健康顾问':{question:'帮我整理这份体检报告里需要关注的项目。',context:'健康资料',lead:'先把资料中的<strong>指标、参考范围和待确认事项</strong>整理清楚，再围绕原报告解释。',steps:['核对指标单位、参考范围和报告日期。','整理下次就诊需要询问的问题。'],follow:['查看原始指标','解释这个项目','整理就诊问题']},
  '出行天气':{question:'帮我看看南京周末的天气和出行注意事项。',context:'天气与出行',lead:'天气页集中展示<strong>城市、日期、逐日预报和更新时间</strong>，再补充与行程有关的提醒。',steps:['切换日期，查看对应的预报时段。','关注天气变化和预警，并核对数据更新时间。'],follow:['切换出行日期','比较目的地','查看预报来源']},
};
const samples = [
  {id:1, title:'智慧农业监测平台建设项目',region:'江苏 · 南京',type:'招标采购',amount:'180',deadline:'11月25日',date:'11-12',source:'政府采购公告'},
  {id:2, title:'农产品仓储数字化系统采购',region:'江苏 · 苏州',type:'招标采购',amount:'96',deadline:'11月28日',date:'11-12',source:'公共资源交易公告'},
  {id:3, title:'水域智能监测设备采购更正公告',region:'浙江 · 杭州',type:'更正延期',amount:'待核实',deadline:'以更正公告为准',date:'11-11',source:'政府采购公告'},
];
const initialPage = new URLSearchParams(location.search).get('view');
const initialState = () => ({
  page:['company','tenders','watch','chat','notice','result'].includes(initialPage) ? initialPage : 'company',
  company:initialPage === 'result' ? '某某科技有限公司（示例）' : '', topic:'basic', source:'公开资料',
  tenderQuery:'',region:'全国',period:'近7天',noticeType:'招标采购',extra:'',showExtra:false,searched:false,
  resultTab:'basic',watchTab:'subscriptions',bookmarks:[],chatAgent:'企业与招投标',chatQuestion:'这家公司的股权情况，下一步该怎么看？',
  subscriptions:[{title:'江苏智慧农业项目',detail:'江苏 · 智慧农业 · 招标采购',enabled:true},{title:'南京数字化采购',detail:'南京 · 数字化 · 招标采购',enabled:true}],
});
let state = initialState();
let toastTimer;
const root = document.getElementById('main-content');
const sheet = document.getElementById('sheet');
function toast(text) {
  clearTimeout(toastTimer);
  const target = document.getElementById('toast');
  target.textContent = text; target.classList.add('show');
  toastTimer = setTimeout(() => target.classList.remove('show'), 3600);
}
function modal(title, content) {
  document.getElementById('sheet-title').textContent = title;
  document.getElementById('sheet-content').innerHTML = content;
  if (!sheet.open) sheet.showModal();
}
function navigate(page) { state.page = page; render(); window.scrollTo({ top:0, behavior:'instant' }); }
function pageIntro(title, text, tag = '工作台') { return `<div class="page-intro"><div><div class="eyebrow desktop-only">WEIYANG · BUSINESS</div><h1>${title}</h1><p>${text}</p></div><span class="subtle-tag">${tag}</span></div>`; }
function taskSwitch(active) { return `<div class="task-switch" role="tablist" aria-label="选择查询任务">${[['company','building','查企业'],['tenders','briefcase','找招标']].map(([key,art,label])=>`<button type="button" role="tab" aria-selected="${active===key}" class="${active===key?'active':''}" data-nav="${key}">${icon(art)}${label}</button>`).join('')}</div>`; }
function sideCards() {
  return `<aside class="support-column"><section class="card aside-card recent"><div class="aside-title">${icon('clock')}<h2>最近查询</h2></div>${[['某某科技有限公司','企业概况 · 示例'],['某某农业集团有限公司','股东股权 · 示例']].map(([name,label],i)=>`<button class="recent-row" data-recent="${i}"><span class="recent-symbol">企</span><span><b>${name}</b><small>${label}</small></span>${icon('chevron')}</button>`).join('')}</section><section class="card aside-card subscriptions"><div class="aside-title">${icon('star')}<h2>我关注的机会</h2></div>${state.subscriptions.slice(0,2).map(row=>`<div class="saved-query"><p>${safe(row.title)}</p><small><i></i>${row.enabled?'持续跟踪':'已暂停'} · 示例</small></div>`).join('')}<button class="text-button" data-nav="watch">查看全部关注${icon('chevron')}</button></section><p class="preview-hint">此预览中的企业、项目与资料均为示例，用于体验界面和操作路径。</p></aside>`;
}
function shortcutActions() { return `<div class="secondary-actions"><button class="quick-link" data-nav="notice">${icon('file')}<span><b>解读招标文件</b><small>上传文件，提炼关键要求</small></span>${icon('chevron')}</button><button class="quick-link" data-nav="watch">${icon('star')}<span><b>我的关注</b><small>项目收藏与自动订阅</small></span>${icon('chevron')}</button></div>`; }
function companyPage() {
  return `${pageIntro('查企业，找机会','从一个名字开始，把需要的资料查清楚。')}<div class="layout"><div class="left-column"><section class="card query-card">${taskSwitch('company')}<form id="company-form"><div class="field-title"><label for="company-input">你想查哪家公司？</label><small>只填这一项即可</small></div><div class="input-wrap">${icon('search')}<input id="company-input" data-field="company" autocomplete="off" maxlength="100" placeholder="输入企业名称或统一社会信用代码" value="${safe(state.company)}"></div><div id="company-error" class="inline-error" role="alert" hidden>请先填写企业名称</div><div class="example">试一试<button type="button" data-example="company">某某科技有限公司</button></div><div class="section-gap"><div class="field-title"><label>想了解什么？</label><small>默认查看企业概况</small></div><div class="topic-options" aria-label="企业查询内容">${Object.entries(topics).map(([key,title])=>`<button type="button" data-topic="${key}" aria-pressed="${state.topic===key}" class="${state.topic===key?'active':''}">${title}</button>`).join('')}</div></div><div class="query-options"><button type="button" data-action="source">数据来源：<span>${state.source}</span>${icon('down')}</button><button type="button" data-action="extra">补充要求${icon(state.showExtra?'close':'down')}</button></div>${state.showExtra?`<div class="extra-requirements"><textarea data-field="extra" maxlength="600" aria-label="补充要求" placeholder="例如：重点了解主营业务，或注明所在地区">${safe(state.extra)}</textarea></div>`:''}<button type="submit" class="primary full">${icon('search')}查询企业</button><p class="input-note">查询后可直接切换资料类型，继续查看同一家企业。</p></form></section>${shortcutActions()}</div>${sideCards()}</div>`;
}
function noticeCard(row) {
  const saved = state.bookmarks.includes(row.id);
  return `<article class="notice-card"><div class="notice-meta"><span class="notice-tag ${row.type==='更正延期'?'correction':''}">${row.type}</span><span>${row.region}</span><span style="margin-left:auto">${row.date}</span></div><h3>${row.title}</h3><div class="notice-stats"><div><small>项目预算</small><b>${row.amount}${row.amount!=='待核实'?'<span> 万元</span>':''}</b></div><div><small>投标截止</small><b style="font-size:13px">${row.deadline}</b></div></div><div class="notice-bottom"><span>${row.source} · 演示</span><div style="display:flex;gap:14px"><button data-favorite="${row.id}" aria-label="${saved?'取消收藏':'收藏'}${row.title}">${icon('star')}${saved?'已收藏':'收藏'}</button><button data-notice="${row.id}">查看要点${icon('chevron')}</button></div></div></article>`;
}
function tenderPage() {
  const words = state.tenderQuery.trim().split(/\s+/).filter(Boolean);
  const list = samples.filter(row => (state.region==='全国'||row.region.includes(state.region)) && (state.noticeType==='全部类型'||row.type===state.noticeType) && words.every(word => row.title.includes(word)) && (state.period!=='今天'||row.date==='11-12'));
  return `${pageIntro('找招标，好项目不漏看','先浏览最新公告，有需要再缩小范围。')}<div class="layout"><div class="left-column"><section class="card query-card">${taskSwitch('tenders')}<form id="tender-form"><div class="field-title"><label for="tender-input">找什么项目？</label><small>留空看最新公告</small></div><div class="input-wrap">${icon('search')}<input id="tender-input" data-field="tenderQuery" maxlength="100" placeholder="输入关键词、行业或企业名称" value="${safe(state.tenderQuery)}"></div><div class="filter-row">${[['region',state.region],['period',state.period],['noticeType',state.noticeType]].map(([key,label])=>`<button type="button" class="filter-pill ${key==='region'&&state.region!=='全国'?'selected':''}" data-filter="${key}">${safe(label)}${icon('down')}</button>`).join('')}</div><button class="primary full" type="submit">${icon('search')}查找项目</button></form></section><section class="result-section"><div class="section-heading"><h2>${state.searched?'筛选结果':'最新公告'} <small class="demo-label">· 演示数据</small></h2><button class="text-button" data-action="subscribe">关注这些条件${icon('chevron')}</button></div>${list.length?list.map(noticeCard).join(''):'<div class="empty-state">当前示例没有匹配项目<br>试试选择“全国”或“全部类型”</div>'}<p class="feed-note">${icon('info')}正式页面读取服务器自动更新的公告库；浏览、筛选和收藏直接完成，不必先发起一段对话。</p></section>${shortcutActions()}</div>${sideCards()}</div>`;
}
function companyDetail() {
  const title = {basic:'基本资料',shareholders:'股东与出资',executives:'主要人员',investments:'对外投资'}[state.resultTab];
  let content = '';
  if (state.resultTab==='basic') content = `<dl class="details-grid">${[['企业名称',state.company],['登记状态','示例状态'],['经营范围','此处展示接口实际返回的经营范围，并保留原始来源。'],['注册地址','此处展示经来源核实的登记地址。'],['资料完整度','缺失字段标为“待核实”，不自动猜测。']].map(([k,v])=>`<div><dt>${k}</dt><dd>${safe(v)}</dd></div>`).join('')}</dl>`;
  else {
    const data={shareholders:[['示例股东 A','示例：60%'],['示例股东 B','示例：40%']],executives:[['示例人员 A','董事'],['示例人员 B','经理']],investments:[['示例关联企业 A','持股示例：70%'],['示例关联企业 B','持股示例：30%']]}[state.resultTab];
    content=`<table class="result-table"><thead><tr><th>${state.resultTab==='executives'?'人员':state.resultTab==='investments'?'企业':'股东'}</th><th style="text-align:right">${state.resultTab==='executives'?'职务':'出资比例'}</th></tr></thead><tbody>${data.map(row=>`<tr><td>${row[0]}</td><td>${row[1]}</td></tr>`).join('')}</tbody></table>`;
  }
  return `<section class="card detail-card"><h3>${title}</h3>${content}<p class="source-note">演示资料，不代表任何企业的真实工商、股权或人员信息。</p></section>`;
}
function resultPage() {
  return `${pageIntro('企业资料','结果、来源和下一步操作，一起查看。','示例结果')}<div class="layout"><div class="left-column"><div class="search-summary">${icon('search')}<span>${safe(state.company)}</span><button class="text-button" data-nav="company">修改查询</button></div><section class="card"><div class="company-head"><div class="company-avatar">${icon('building')}</div><div><h2>${safe(state.company)}</h2><div class="small-tags"><span>企业资料</span><span>界面演示</span></div></div></div><div class="company-stats"><div><small>登记状态</small><strong>以数据为准</strong></div><div><small>注册资本</small><strong>以数据为准</strong></div><div><small>成立日期</small><strong>以数据为准</strong></div></div><div class="result-tabs" role="tablist" aria-label="企业结果类型">${Object.entries(topics).map(([key,label])=>`<button role="tab" aria-selected="${state.resultTab===key}" class="${state.resultTab===key?'active':''}" data-result-tab="${key}">${label.replace('企业概况','概况').replace('股东股权','股东').replace('主要人员','高管').replace('对外投资','投资')}</button>`).join('')}</div></section>${companyDetail()}<div class="card detail-card"><div class="section-heading" style="margin-bottom:0"><h3 style="margin:0">资料来源</h3><button class="text-button" data-action="evidence">查看明细${icon('chevron')}</button></div><p class="source-note" style="margin-top:5px">正式查询展示来源、查询时间，以及待核实字段。</p></div><div class="bottom-actions"><button class="secondary" data-action="export">${icon('download')}导出资料</button><button class="primary" data-nav="chat">${icon('chat')}继续问未央</button></div></div>${sideCards()}</div>`;
}
function watchPage() {
  let body = '';
  if (state.watchTab==='subscriptions') body=state.subscriptions.map((row,i)=>`<article class="notice-card"><div class="watch-state"><i></i>${row.enabled?'持续跟踪':'已暂停'} · 演示</div><h3>${safe(row.title)}</h3><p class="muted" style="font-size:12px;margin-top:7px">${safe(row.detail)}</p><div class="watch-footer"><button data-edit-sub="${i}">修改条件</button><button data-toggle-sub="${i}">${row.enabled?'暂停跟踪':'恢复跟踪'}</button></div></article>`).join('');
  if (state.watchTab==='favorites') body=state.bookmarks.length?samples.filter(row=>state.bookmarks.includes(row.id)).map(noticeCard).join(''):'<div class="empty-state">还没有收藏项目<br>在公告卡片上点一下“收藏”，就能保存在这里。</div>';
  if (state.watchTab==='alerts') body=`<article class="card alert-item"><div class="alert-symbol">${icon('bell')}</div><div><h3>你关注的项目有一条更正</h3><p>智慧农业监测平台建设项目（示例）<br>投标时间发生调整，可打开公告核对。</p><button class="text-button" data-notice="1">查看更正要点${icon('chevron')}</button><small style="display:block">示例提醒 · 非真实公告</small></div></article>`;
  return `<div class="compact-page">${pageIntro('我的关注','保存一次条件，回来直接看变化。')}<div class="watch-tabs" role="tablist" aria-label="关注分类">${[['subscriptions','自动订阅'],['favorites','项目收藏'],['alerts','更新提醒']].map(([key,label])=>`<button role="tab" aria-selected="${state.watchTab===key}" class="${state.watchTab===key?'active':''}" data-watch-tab="${key}">${label}</button>`).join('')}</div>${body}<button class="text-button" data-nav="tenders">${icon('briefcase')}再找一些项目${icon('chevron')}</button><p class="preview-hint">本页操作仅改变本地预览状态，不创建真实订阅。</p></div>`;
}
function readNoticePage() {
  return `<div class="compact-page">${pageIntro('读公告，先看关键要求','放进一份文件或一个链接，快速找到重点。')}<section class="card query-card"><button class="upload-box" data-action="upload">${icon('upload')}<strong id="upload-label">选择招标文件</strong><small>PDF、Word · 预览不上传文件</small></button><input type="file" id="file-input" accept=".pdf,.doc,.docx" hidden><p class="or-line">或者粘贴原文链接</p><form id="notice-form"><div class="input-wrap">${icon('link')}<input id="notice-url" type="url" aria-label="公告原文链接" placeholder="粘贴招标公告的原文链接"></div><button class="primary full" style="margin-top:20px" type="submit">${icon('file')}解读公告</button></form></section><div class="card detail-card"><h3>整理为一张项目清单</h3><p class="muted" style="font-size:12px;line-height:2">预算与截止时间 · 投标资格 · 所需材料<br>评分要求 · 更正事项 · 原文出处</p></div></div>`;
}
function professionalCard() {
  if (state.chatAgent==='企业与招投标') return `<div class="card detail-card" style="margin:0 0 20px"><h3 style="margin:0 0 10px">股权核对清单 <span class="demo-label">· 专业结果示例</span></h3><dl class="details-grid"><div><dt>第一步</dt><dd>查看登记股东与出资比例</dd></div><div><dt>第二步</dt><dd>继续核对上层股东和资料日期</dd></div><div><dt>需要分清</dt><dd>法定代表人、登记股东与实际控制人</dd></div></dl></div>`;
  if (state.chatAgent==='行情查询') return `<div class="card detail-card" style="margin:0 0 20px"><div class="section-heading"><h3 style="margin:0">上证指数</h3><span class="demo-label">示例行情</span></div><div style="display:flex;align-items:baseline;gap:12px"><strong style="font-size:32px;color:#3f9b83">3,655.83</strong><span style="color:#5a9e8a;font-size:13px">-0.67%</span></div><svg aria-label="示例行情走势图" viewBox="0 0 360 70" style="width:100%;height:70px;margin:10px 0;color:#65a691"><path d="M0 15 20 22 40 17 60 30 80 27 100 34 120 21 140 30 160 40 180 31 200 39 220 35 240 47 260 40 280 47 300 41 320 54 340 48 360 56"/></svg><p class="source-note" style="margin-top:4px">仅演示行情卡片；实际来源、时间和数字待真实查询返回。</p></div>`;
  const cards={
    '公文写作':['文档交付清单',['主题与文种','事实、称谓与数字核对','版式与段落检查','Word预览与下载']],
    'PPT助手':['演示文稿工作区',['先确认提纲','选择视觉风格','逐页预览与修改','导出可编辑PPT']],
    '海报设计':['海报制作工作区',['确认标题、正文与尺寸','画面与文字分层','逐项核对中文文字','保存原图与可编辑稿']],
    '深度研究':['研究资料卡',['研究范围','来源与日期','已核实内容','证据冲突与待核实项']],
    '图片转文字':['识别结果工作区',['原图与文字对照','存疑字符单独标记','表格结构保留','编辑与导出']],
    '健康顾问':['健康资料整理',['指标与参考范围','需要关注的变化','资料中的不确定项','就诊问题清单']],
    '出行天气':['天气与行程卡',['城市与日期','逐日天气和温度','出行影响与提醒','来源与更新时间']],
  };
  const [title,rows]=cards[state.chatAgent];
  return `<div class="card detail-card" style="margin:0 0 20px"><h3 style="margin:0 0 12px">${title} <span class="demo-label">· 布局示例</span></h3><dl class="details-grid">${rows.map((text,i)=>`<div><dt>0${i+1}</dt><dd>${text}</dd></div>`).join('')}</dl></div>`;
}
function chatPage() {
  const enterprise=state.chatAgent==='企业与招投标';
  const example=agentExamples[state.chatAgent];
  return `<div class="chat-shell"><div class="chat-scroll"><div class="chat-context">${icon(enterprise?'building':'spark')}<span><b>${state.chatAgent}</b> · ${enterprise?safe(state.company||example.context):example.context}</span><button class="text-button" style="margin-left:auto;min-height:25px;font-size:10px" data-action="agent-picker">切换示例${icon('down')}</button></div><div class="chat-user"><p>${safe(state.chatQuestion)}</p><small>你 · 界面演示</small></div><article class="agent-answer"><div class="chat-author"><img src="${brand}" alt=""><span>未央</span><small>${state.chatAgent}</small></div><button type="button" class="progress-line" data-action="progress">${icon('check')}<span>专业任务进度</span><span>界面示例 · 展开</span></button><div class="answer-body"><p>${example.lead}</p>${professionalCard()}<h3>${enterprise?'接下来可以这样查':'下一步操作'}</h3><ul>${example.steps.map(text=>`<li>${text}</li>`).join('')}</ul><div class="evidence-row">${icon('file')}<span>来源与依据 · 示例入口</span><button class="text-button" data-action="evidence">查看${icon('chevron')}</button></div></div><div class="answer-actions"><button aria-label="复制回答" data-action="copy">${icon('copy')}</button><button aria-label="朗读回答" data-action="voice">${icon('speaker')}</button><button aria-label="重新查询" data-action="redo">${icon('refresh')}</button></div></article><div class="followups">${example.follow.map(text=>`<button data-follow="${text}">${text}</button>`).join('')}</div></div><div class="chat-input"><form class="composer" id="chat-form"><input data-field="chatDraft" aria-label="继续询问" placeholder="围绕当前资料，继续问…" maxlength="600"><button type="submit" aria-label="发送预览消息">${icon('send')}</button></form><p class="chat-footnote">交互预览 · 回答与卡片均为示例，未调用真实模型</p></div></div>`;
}
function render() {
  const pages={company:companyPage,tenders:tenderPage,result:resultPage,watch:watchPage,notice:readNoticePage,chat:chatPage};
  root.className=state.page==='company'?'company-home':state.page==='result'?'company-result':state.page==='chat'?'chat-page':'';
  root.innerHTML=pages[state.page]();
  document.getElementById('page-title').textContent=({watch:'我的关注',notice:'解读公告',chat:'智能体对话'})[state.page]||'企业与招投标';
  document.querySelectorAll('[data-icon]').forEach(node=>node.innerHTML=icon(node.dataset.icon));
  document.querySelectorAll('.sidebar [data-nav]').forEach(node=>node.classList.toggle('active',node.dataset.nav===(state.page==='result'?'company':state.page)));
  document.querySelector('.nav-count').textContent=state.subscriptions.length;
}
function openFilter(key) {
  const config={region:['项目地区',['全国','江苏','浙江','广东','北京','上海']],period:['公告时间',['今天','近7天','近30天','不限时间']],noticeType:['公告类型',['招标采购','中标成交','更正延期','采购意向','终止废标','全部类型']]};
  const [title,values]=config[key];
  modal(title,`<p class="sheet-description">选择后会保留其他筛选条件。</p><div class="sheet-options">${values.map(v=>`<button data-set-filter="${key}" data-value="${v}" class="${state[key]===v?'active':''}">${v}</button>`).join('')}</div>${key==='region'?'<label class="sheet-control">其他城市<input id="custom-region" maxlength="30" placeholder="例如：江苏南京"></label><button class="primary full" data-action="custom-region">使用这个地区</button>':''}`);
}
function subscribeModal(editIndex=null) {
  const row=editIndex===null?null:state.subscriptions[editIndex];
  const title=row?.title||`${state.region==='全国'?'':state.region}${state.tenderQuery||'招标项目'}`;
  modal(editIndex===null?'关注这些项目':'修改关注条件',`<p class="sheet-description">保存后在“我的关注”查看匹配的新公告与更正。本预览只演示操作。</p><label class="sheet-control">关注名称<input id="subscribe-name" maxlength="50" value="${safe(title)}"></label><p class="sheet-description">${safe(row?.detail||`${state.region} · ${state.tenderQuery||'不限关键词'} · ${state.noticeType}`)}</p><div class="sheet-actions"><button class="secondary" data-action="close">再看看</button><button class="primary" data-confirm-sub="${editIndex===null?'new':editIndex}">确认关注</button></div>`);
}
document.addEventListener('input',event=>{
  const key=event.target.dataset.field;
  if (['company','tenderQuery','extra','chatDraft'].includes(key)) state[key]=event.target.value;
  if(key==='company') document.getElementById('company-error')?.setAttribute('hidden','');
});
document.addEventListener('change',event=>{
  if(event.target.id!=='file-input') return;
  const file=event.target.files?.[0];
  if(file) { document.getElementById('upload-label').textContent=file.name; toast('已选择文件名用于预览，不读取或上传文件'); }
});
document.addEventListener('submit',event=>{
  event.preventDefault();
  if(event.target.id==='company-form') {
    state.company=state.company.trim();
    if(!state.company) { document.getElementById('company-error').hidden=false; document.getElementById('company-input').focus(); return; }
    state.resultTab=state.topic; navigate('result');
  }
  if(event.target.id==='tender-form') { state.searched=true; render(); toast('筛选操作已演示；结果仍为示例数据'); }
  if(event.target.id==='notice-form') {
    modal('公告要点示例','<p class="sheet-description">正式接入后，这里集中显示投标资格、预算、截止时间、所需材料和更正事项，并提供原文出处。</p><div class="sheet-actions"><button class="secondary" data-action="close">返回</button><button class="primary" data-nav="chat">继续问未央</button></div>');
  }
  if(event.target.id==='chat-form' && state.chatDraft?.trim()) { state.chatQuestion=state.chatDraft.trim(); state.chatDraft=''; render(); toast('已演示追问位置；此预览没有调用模型'); }
});
document.addEventListener('click',event=>{
  const b=event.target.closest('button'); if(!b) return;
  const d=b.dataset;
  if(d.nav) { sheet.close(); navigate(d.nav); return; }
  if(d.topic) { state.topic=d.topic; render(); return; }
  if(d.resultTab) { state.resultTab=d.resultTab; render(); return; }
  if(d.watchTab) { state.watchTab=d.watchTab; render(); return; }
  if(d.filter) { openFilter(d.filter); return; }
  if(d.setFilter) { state[d.setFilter]=d.value; sheet.close(); render(); return; }
  if(d.example) { state.company='某某科技有限公司（示例）'; render(); document.getElementById('company-input').focus(); return; }
  if(d.recent!==undefined) { state.company=['某某科技有限公司（示例）','某某农业集团有限公司（示例）'][+d.recent]; state.topic=+d.recent?'shareholders':'basic'; state.resultTab=state.topic; navigate('result'); return; }
  if(d.favorite) { const id=+d.favorite;state.bookmarks=state.bookmarks.includes(id)?state.bookmarks.filter(v=>v!==id):[...state.bookmarks,id];render();toast(state.bookmarks.includes(id)?'已收藏到预览的“我的关注”':'已取消预览收藏');return; }
  if(d.notice) { const row=samples.find(v=>v.id===+d.notice);modal('项目要点',`<p class="sheet-description">演示数据 · 非真实公告</p><h3>${row.title}</h3><dl class="details-grid" style="margin-top:20px"><div><dt>项目地区</dt><dd>${row.region}</dd></div><div><dt>公告类型</dt><dd>${row.type}</dd></div><div><dt>预算</dt><dd>${row.amount}${row.amount!=='待核实'?'万元':''}</dd></div><div><dt>截止时间</dt><dd>${row.deadline}</dd></div></dl><div class="sheet-actions"><button class="secondary" data-action="original">原文出处</button><button class="primary" data-nav="chat">请未央解读</button></div>`);return; }
  if(d.toggleSub!==undefined) { const row=state.subscriptions[+d.toggleSub];row.enabled=!row.enabled;render();return; }
  if(d.editSub!==undefined) { subscribeModal(+d.editSub);return; }
  if(d.confirmSub!==undefined) { const title=document.getElementById('subscribe-name').value.trim();if(!title)return;const row={title,detail:`${state.region} · ${state.tenderQuery||'不限关键词'} · ${state.noticeType}`,enabled:true};if(d.confirmSub==='new')state.subscriptions=state.subscriptions.concat(row).slice(-20);else state.subscriptions[+d.confirmSub]={...state.subscriptions[+d.confirmSub],title};sheet.close();navigate('watch');toast('关注流程已演示，没有创建真实订阅');return; }
  if(d.agent) { state.chatAgent=d.agent;state.chatQuestion=agentExamples[d.agent].question;sheet.close();render();return; }
  if(d.follow) { state.chatQuestion=d.follow;render();toast('已演示围绕当前任务继续操作');return; }
  const actions={
    source:()=>modal('企业资料来源',`<div class="provider-option active">${icon('check')}<div><b>公开资料</b><small>使用已配置的搜索与公开来源</small></div><span>当前选择</span></div><div class="provider-option">${icon('building')}<div><b>企百科</b><small>需要配置账号，可能产生服务费用</small></div><span>未配置</span></div><p class="sheet-description">正式版在设置中保存基础地址和访问密钥；此预览不收集凭据。</p><button class="primary full" data-action="close">知道了</button>`),
    extra:()=>{state.showExtra=!state.showExtra;render();},
    subscribe:()=>subscribeModal(),
    export:()=>modal('导出企业资料','<p class="sheet-description">选择交付格式。这里展示操作位置，不生成真实企业报告。</p><div class="sheet-options"><button data-action="export-demo">Word 报告</button><button data-action="export-demo">Excel 表格</button></div>'),
    'export-demo':()=>{sheet.close();toast('导出入口预览；正式接入后生成可编辑资料');},
    evidence:()=>modal('来源与核对情况','<p class="sheet-description">正式结果逐项显示来源、资料日期、是否已读原文，以及缺失或冲突的信息。这里没有真实查询回执。</p><button class="primary full" data-action="close">返回结果</button>'),
    upload:()=>document.getElementById('file-input').click(),
    'agent-picker':()=>modal('预览智能体结果样式',`<p class="sheet-description">各智能体共用阅读边距，专业结果按任务展示。以下均为设计示例。</p><div class="sheet-options">${agents.map(a=>`<button data-agent="${a}" class="${state.chatAgent===a?'active':''}">${a}</button>`).join('')}</div>`),
    'custom-region':()=>{const v=document.getElementById('custom-region').value.trim();if(v){state.region=v;sheet.close();render();}},
    progress:()=>modal('专业任务进度示例','<p class="sheet-description">这里按实际回执显示查询、读取与核对步骤。当前仅为界面预览，没有真实工具调用记录。</p><button class="primary full" data-action="close">返回对话</button>'),
    original:()=>toast('示例公告没有真实原文链接；正式版在这里打开官方原文'),
    copy:()=>toast('复制入口预览；正式版复制当前回答与来源'),
    voice:()=>toast('朗读入口预览；此页面不会访问麦克风'),
    redo:()=>toast('重新查询入口预览；不会发送收费请求'),
    close:()=>sheet.close(),
  };
  actions[d.action]?.();
});
document.getElementById('close-sheet').addEventListener('click',()=>sheet.close());
document.getElementById('back-button').addEventListener('click',()=>navigate('company'));
document.getElementById('reset-preview').addEventListener('click',()=>{state=initialState();sheet.close();render();toast('预览已重置');});
sheet.addEventListener('click',event=>{if(event.target===sheet){const r=sheet.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)sheet.close();}});
render();
