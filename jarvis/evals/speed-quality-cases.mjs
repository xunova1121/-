/** 补充回归与原30题分开编号；虚构比分只测上下文，不冒充实时赛果。 */
const rows = [
  { category: 'scope', group: 'correction', prompt: '下面是用于测试的六场虚构赛果，不是真实比赛：\n1. 青松队 vs 白云队：2-1\n2. 海风队 vs 星河队：0-0\n3. 山川队 vs 红枫队：1-3\n4. 晨光队 vs 飞燕队：2-2\n5. 长桥队 vs 湖畔队：3-0\n6. 银杉队 vs 金桂队：0-1\n先记住，回复收到即可。', followup: '我那6场比分是多少？排成手机容易看的表格，只要这6场，不用联网。', rubric: ['只列原六场，比分逐项与用户材料一致', '明确属于用户提供的虚构赛果，不声称实时查询', '少列表格，无其他比赛、无联网工具调用'], checks: { contains: ['青松', '银杉'], maxChars: 800 } },
  { category: 'sports_news', group: 'live', prompt: '今天有什么体育资讯？只要3条新闻和来源，不要比分赛程。', rubric: ['交付3条体育报道而不是比赛清单', '来源和日期可核对，不把比赛数据当资讯', '无可靠报道时简短说明，不能编造'], checks: { links: true, maxChars: 1200 } },
  { category: 'emotion', group: 'chat', prompt: '做这个项目半个月了，今天又失败，我有点泄气。先陪我聊两句，不要给我开发计划。', rubric: ['回应具体挫折，不说空泛安慰或诊断心理状态', '不列开发计划，不反问一串问题', '简短自然，有温度但不假装亲身经历'], checks: { maxChars: 300 } },
  { category: 'writing_voice', group: 'writing', prompt: '我们团队连着两周加班，今天终于把客户系统上线了。我是负责人，写一段发群里的感谢，150字以内，提到昨晚同事一起排查故障。自然一点，不要口号，不要免责声明。', rubric: ['负责人第一人称，具体提到两周与昨晚排障', '真诚具体，不凭空增加人物姓名或事件', '150字以内，自然段落而不是提纲'], checks: { maxChars: 150 } },
  { category: 'negative_constraint', group: 'correction', prompt: '把这段通知改得清楚：设备维护，周六上午9点到11点暂停服务。只保留原因和影响，不要出现日期和时间，不要解释修改过程。', rubric: ['保留设备维护和暂停服务', '无周六、9点、11点等日期时间', '直接交付通知，不增加额外解释'], checks: { excludes: ['周六', '9点', '11点', '上午'], contains: ['维护', '暂停'] } },
  { category: 'basic', group: 'knowledge', prompt: '一公斤等于多少克？只回答结果。', rubric: ['1000克', '不调用外部工具，不解释过程、不增加标题'], checks: { contains: ['1000'], maxChars: 20 } }
];
export const speedQualityCases = rows.map((row, i) => ({ id: `speed-quality-${String(i + 1).padStart(2, '0')}`, requires: [], targetMs: row.group === 'live' ? 60000 : 15000, timeoutMs: 180000, ...row }));
