import {describe,it,expect} from 'vitest';
import {lookupIntent} from '../src/agent/lookup/intent.js';
import {lookupPlan,marketIndex} from '../src/agent/lookup/plan.js';
import {marketFallback} from '../src/agent/lookup/fallback.js';
import {createLookupDelivery,digestRows,oneLine} from '../src/agent/lookupDelivery.js';
// 用户 2026-11-03：“今天大盘的情况”没取指数、拿原话去搜，到点后贴出6段搜索原文，混着金价“大盘价”、楼盘“核心大盘”、重复条目
const getTool=name=>['get_today_news','web_search','get_stock_kline'].includes(name)?{name,input_schema:{properties:{}}}:null;
const planOf=text=>lookupPlan(lookupIntent(text),{text,getTool});
describe('问大盘先取指数，兜底不贴搜索原文',()=>{
  it('大盘/沪指/上证/A股 → 上证指数日K；深成指、创业板各自的指数',()=>{
    for(const t of ['今天大盘的情况','今天大盘怎么样','我在问大盘情况，你这个是干嘛','沪指今天怎么样','A股行情'])expect(planOf(t),t).toMatchObject({name:'get_stock_kline',args:{code:'sh000001',adjustment:'none'}});
    expect(planOf('深成指行情').args.code).toBe('sz399001');expect(planOf('创业板今天行情').args.code).toBe('sz399006');
  });
  it('有证券代码仍按代码；金价、汇率、港美股、楼盘不当成大盘',()=>{
    expect(planOf('600519 收盘价').args.code).toBe('600519');
    for(const t of ['今日大盘金价','汇率行情','港股大盘','美股大盘','华侨城核心大盘楼盘'])expect(marketIndex(t),t).toBe('');
    expect(planOf('今天油价多少')?.name).toBe('web_search');
  });
  it('指数兜底写名称、盘中点位和涨跌幅，盘中不冒充收盘',()=>{
    const out=JSON.stringify({symbol:'sh000001',source:'腾讯行情',sourceUrl:'https://web.ifzq.gtimg.cn/x',adjustment:'none',latestClose:3638.03,previousClose:3599.2,priceDate:'2026-11-02',previousPriceDate:'2026-10-30',bars:[{date:'2026-11-02',open:3600,close:3638.03,high:3648,low:3590,volume:1},{date:'2026-11-03',open:3640,close:3620.5,high:3651,low:3611,volume:1}]});
    const text=marketFallback(out);
    expect(text).toContain('上证指数');expect(text).toContain('2026-11-03盘中');expect(text).toContain('3620.5');expect(text).toContain('跌0.48%');
    expect(text).toContain('2026-11-02收盘：3638.03，涨1.08%');expect(text).toContain('不是逐笔实时行情');
    const closed=marketFallback(JSON.stringify({...JSON.parse(out),bars:JSON.parse(out).bars.slice(0,1)}));
    expect(closed).not.toContain('盘中');expect(closed).toContain('日K收盘数据，不是实时行情');
  });
  it('搜索兜底：去重、剔除金价楼盘和原始JSON标题，最多5条一句话，末尾只写一次待核实',()=>{
    const d=createLookupDelivery('今天大盘的情况');
    const rows=[
      {title:'大盘收3638点，今天周二A股行情可能这样走',url:'https://a.cn/1',snippet:'昨天大盘高开高走，收3638点，涨1.08%，成交1.79万亿。'+'后面还有很长很长的分析文字。'.repeat(20)},
      {title:'北京黄金回收观察：今日大盘金价怎么看',url:'https://a.cn/2',snippet:'今日大盘金价1141元/克，回收价1050元/克。'},
      {title:'北京黄金回收观察：今日大盘金价怎么看',url:'https://a.cn/3',snippet:'今日大盘金价1141元/克。'},
      {title:'华侨城核心大盘|绿景白石洲璟庭学区情况详解',url:'https://a.cn/4',snippet:'学区以南山教育局公示为准。'},
      {title:'{"code":0,"stg_version":"v1"}',url:'https://a.cn/5',snippet:'为什么今天跌幅这么大，资金短线思维，A股承压。'},
      {title:'收评：今天周二开始，市场准备迎来新的大变盘',url:'https://a.cn/6',snippet:'50ETF放量维稳指数，然后抬300ETF。'}
    ];
    d.record({name:'web_search',ok:true,output:JSON.stringify(rows)});
    const text=d.text();
    expect(text).toContain('3638');expect(text).toContain('a.cn/6');
    for(const bad of ['金价','学区','stg_version','a.cn/3'])expect(text,bad).not.toContain(bad);
    expect(text.match(/待核实/g)).toHaveLength(1);
    expect(text).not.toContain('很长很长的分析文字。很长');
    expect(digestRows(Array.from({length:9},(_,i)=>({title:'A股条目'+i,url:'https://b.cn/'+i,summary:'沪指收涨'})),'大盘').length).toBe(5);
  });
  it('全部不对题时不凑答案；一句话摘要按句号截断',()=>{
    const d=createLookupDelivery('今天大盘的情况');
    d.record({name:'web_search',ok:true,output:JSON.stringify([{title:'今日大盘金价',url:'https://a.cn/g',snippet:'黄金回收'}])});
    expect(d.text()).toContain('不对题');expect(d.text()).not.toContain('a.cn/g');
    expect(oneLine('第一句说明大盘今天高开低走，成交放量到两万亿。第二句很长'.padEnd(120,'字'))).toBe('第一句说明大盘今天高开低走，成交放量到两万亿。');
    expect(oneLine('#股票# 沪指收涨')).toBe('沪指收涨');
  });
});
