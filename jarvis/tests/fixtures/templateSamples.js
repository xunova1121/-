/** 六套版式模板的中文样例（测试与样图共用） */
export const TEMPLATE_SAMPLES = {
  news_brief: { id: 'news_brief', style: 'blue', content: { date: '2026年11月18日', headline: 'APEC深圳峰会今日开幕', summary: '多国领导人凌晨密集抵深，会期11月18—19日。', items: [
    { title: '普京抵达深圳', detail: '18日凌晨抵深，蔡奇到机场迎接。', source: '中新网 02:13' }, { title: '韩国总统李在明抵深', source: '央广网 00:58' },
    { title: '马来西亚总理安瓦尔抵深', detail: '还将出席APEC工商领导人峰会。', source: '央广网 00:34' }, { title: '文莱苏丹哈桑纳尔抵深', source: '央广网 00:23' }], footer: '来源：中新网、央广网 · 整理时间 11月18日 06:46（北京时间）' } },
  person_event: { id: 'person_event', content: { name: '黄仁勋', role: '英伟达创始人', headline: '辞职五天后首次发声', summary: '表示若董事会邀请愿意回归，董事会主席当天回应不打算让其复职。', quote: '如果董事会认为我的回归符合各方最佳利益，我将很荣幸重新担任CEO。',
    events: [{ date: '11月12日', text: '辞去英伟达总裁、CEO及董事职务，即刻生效', focus: true }, { date: '11月12–17日', text: '辞职后沉默5天' }, { date: '11月17日', text: '社交媒体发表声明，就个人问题道歉', focus: true }, { date: '11月17日', text: '董事会主席：公司不打算让其复职' }, { date: '11月17日', text: '新设国家安全与出口管制监督委员会' }],
    facts: [{ label: '掌舵年数', value: '33年' }, { label: '持股约', value: '3.6%' }, { label: '道指当日', value: '-1.64%' }], footer: '来源：新浪转都市快报、财联社 · 11月18日' } },
  schedule: { id: 'schedule', style: 'green', content: { date: '11月17日 晚', headline: '今晚足球赛程', groups: [{ name: '中国球队', rows: [{ time: '19:35', text: '中国U19 vs 韩国U19', focus: true }, { time: '20:00', text: '中国男足 vs 巴林', note: '世预赛', focus: true }] },
    { name: '欧洲U19', rows: [{ time: '20:00', text: '冰岛U19 vs 威尔士U19' }, { time: '20:00', text: '芬兰U19 vs 西班牙U19' }, { time: '20:30', text: '直布罗陀U19 vs 拉脱维亚U19' }] }], footer: '信息整理：直播吧 · 以官方为准' } },
  event_promo: { id: 'event_promo', content: { eyebrow: '社区活动', headline: '秋季亲子市集', subtitle: '手作、美食、旧物交换，带孩子来玩一下午', info: [{ label: '时间', value: '11月23日（周六）13:00–17:00' }, { label: '地点', value: '幸福里社区中心广场' }, { label: '费用', value: '免费入场' }],
    highlights: ['20多个亲子手作摊位', '旧绘本交换角', '现场乐队演出'], cta: '扫码报名，前100组送礼包', footer: '主办：幸福里社区居委会' } },
  data_report: { id: 'data_report', content: { period: '2026年1–9月', headline: '广东制造业上市公司前三季度', kpis: [{ label: '公司数量', value: '647家' }, { label: '营业收入', value: '5.4万亿', change: '+19.4%' }, { label: '高于全国', value: '7个百分点' }],
    chart: { title: '营收同比增速对比', unit: '%', points: [{ label: '广东', value: 19.4 }, { label: '全国', value: 12.4 }] }, notes: ['增速主要来自创新、出海与并购', '数据来自新华财经整理的上市公司财报'], footer: '来源：新华财经 · 11月17日' } },
  tips: { id: 'tips', style: 'warm', content: { headline: '寒潮来了，孕晚期出门注意', intro: '南京今天最低1℃，早晚温差大。', items: [{ title: '穿厚外套护住腰腹', detail: '围巾、手套都带上，别让肚子受凉。' }, { title: '雾天出行多留时间', detail: '早晨能见度约4公里，打车开车都要慢。' }, { title: '避开风口', detail: '陆上阵风6～7级。' }, { title: '随身带好产检资料' }], footer: '天气来源：和风天气 · 11月18日 06:37' } }
};
