import {describe,it,expect} from 'vitest';
import {quoteTarget,parseTencentQuote,parseTencentSuggest,parseEastQuote,createMarketQuoteTool} from '../src/agent/marketQuote.js';
import {lookupIntent} from '../src/agent/lookup/intent.js';
import {lookupPlan} from '../src/agent/lookup/plan.js';
import {createLookupDelivery} from '../src/agent/lookupDelivery.js';
import {CORE} from '../src/agent/toolLoader.js';
// 用户 2026-11-03：金价、汇率、按名字问个股、港美股原先只能搜文章再找数字，常是旧文或自媒体观点
const tencentLine=(sym,name,price,prev,time,chg,pct,high,low)=>{const f=Array(50).fill('');Object.assign(f,{1:name,2:sym,3:price,4:prev,5:prev,30:time,31:chg,32:pct,33:high,34:low});return `v_${sym}="${f.join('~')}";`;};
const res=(body,ok=true,status=200)=>({ok,status,text:async()=>body,arrayBuffer:async()=>new TextEncoder().encode(body).buffer});
const tool=(routes,now=Date.parse('2026-11-03T10:05:00+08:00'))=>{const urls=[];const t=createMarketQuoteTool({now:()=>now,fetchImpl:async url=>{urls.push(url);const hit=routes.find(([re])=>re.test(url));if(!hit)throw Object.assign(new TypeError('fetch failed'),{kind:'network'});return typeof hit[1]==='function'?hit[1](url):hit[1];}});return {t,urls};};
const getTool=name=>['web_search','get_stock_kline','get_market_quote'].includes(name)?{name,input_schema:{properties:{}}}:null;
const planOf=text=>lookupPlan(lookupIntent(text),{text,getTool,now:Date.parse('2026-11-03T10:00:00+08:00')});

describe('实时报价：认对象',()=>{
  it('金价、汇率、指数、港美股、按名字问个股都认得；油价、比特币、闲聊不认',()=>{
    expect(quoteTarget('今天金价多少')).toEqual({kind:'gold',target:'金价'});
    expect(quoteTarget('美元汇率')).toEqual({kind:'fx',target:'USD'});expect(quoteTarget('日元兑人民币')).toEqual({kind:'fx',target:'JPY'});
    expect(quoteTarget('纳斯达克今天怎么样')).toEqual({kind:'index',target:'纳斯达克综合指数'});
    expect(quoteTarget('今天港股怎么样')).toEqual({kind:'index',target:'港股'});expect(quoteTarget('美股行情')).toEqual({kind:'index',target:'美股'});
    expect(quoteTarget('茅台股价')).toEqual({kind:'stock',target:'茅台'});expect(quoteTarget('腾讯控股今天股价多少')).toEqual({kind:'stock',target:'腾讯控股'});
    expect(quoteTarget('hk00700股价')).toEqual({kind:'stock',target:'hk00700'});expect(quoteTarget('usAAPL')).toEqual({kind:'stock',target:'usAAPL'});
    for(const t of ['今天油价','比特币价格','我最近好累','茅台'])expect(quoteTarget(t),t).toBeNull();
  });
  it('查询路线：报价类先走get_market_quote；代码收盘价、大盘仍走日K；油价用调价口径搜索词；没有报价工具照旧搜索',()=>{
    for(const [t,target] of [['今天金价多少','金价'],['美元汇率','USD'],['茅台股价','茅台'],['恒生指数','恒生指数'],['美股行情','美股'],['600519实时行情','600519']])expect(planOf(t),t).toMatchObject({name:'get_market_quote',args:{target}});
    expect(planOf('600519 收盘价').name).toBe('get_stock_kline');expect(planOf('今天大盘的情况').args.code).toBe('sh000001');
    expect(planOf('今天油价').args.query).toContain('92号');expect(planOf('比特币价格').name).toBe('web_search');
    expect(planOf('600519 去年最高价')?.name).not.toBe('get_market_quote');
    const old=lookupPlan(lookupIntent('茅台股价'),{text:'茅台股价',getTool:n=>n==='get_market_quote'?null:getTool(n)});expect(old.name).toBe('web_search');
    expect(CORE.has('get_market_quote')).toBe(true);
  });
});

describe('实时报价：解析与校验',()=>{
  it('腾讯行情：名称、现价、昨收、涨跌幅、最高最低、时间；缺价或高低矛盾不采用',()=>{
    const rows=parseTencentQuote(tencentLine('sh600519','贵州茅台','1500.00','1490.00','20261103100458','10.00','0.67','1510.00','1488.00')+'\n'+tencentLine('hk00700','腾讯控股','420.2','415.0','2026/11/03 10:04:01','5.2','1.25','421','414'));
    expect(rows[0]).toMatchObject({symbol:'sh600519',name:'贵州茅台',price:1500,prevClose:1490,changePct:0.67,high:1510,low:1488,time:'2026-11-03 10:04:58'});
    expect(rows[1].time).toBe('2026-11-03 10:04:01');
    expect(parseTencentQuote(tencentLine('sh1','坏','0','1','x','','','',''))).toEqual([]);
    expect(parseTencentQuote(tencentLine('sh2','矛盾','10','9','x','1','1','8','12'))[0].high).toBeUndefined();
    expect(parseTencentQuote('v_pv_none_match="1";')).toEqual([]);
  });
  it('腾讯代码查询：解开\\u转义；美股去后缀转大写；只要股票/指数/ETF',()=>{
    const hint='v_hint="sh~600519~\\u8d35\\u5dde\\u8305\\u53f0~gzmt~GP-A^us~aapl.oq~\\u82f9\\u679c~pg~GP^sz~159001~\\u8d27\\u5e01~hb~JJ"';
    expect(parseTencentSuggest(hint)).toEqual([{symbol:'sh600519',name:'贵州茅台',type:'GP-A'},{symbol:'usAAPL',name:'苹果',type:'GP'}]);
    expect(parseTencentSuggest('v_hint="N"')).toEqual([]);
  });
  it('东方财富：fltt=2小数、时间戳按北京时间；缺名称或价格不采用',()=>{
    const row=parseEastQuote(JSON.stringify({data:{f43:952.3,f44:955,f45:948.1,f46:950,f58:'黄金9999',f60:949.5,f86:1793671200,f169:2.8,f170:0.29}}),'118.AU9999');
    expect(row).toMatchObject({name:'黄金9999',price:952.3,prevClose:949.5,changePct:0.29,high:955,low:948.1});expect(row.time).toMatch(/^2026-11-0\d \d\d:\d\d:\d\d$/);
    expect(parseEastQuote(JSON.stringify({data:{f43:'-',f58:'x',f60:1}}),'a')).toBeNull();expect(parseEastQuote(JSON.stringify({data:null}),'a')).toBeNull();
  });
});

describe('实时报价：工具取数',()=>{
  it('按名字问个股：先查代码再取腾讯行情，回执带来源、时间和延迟说明',async()=>{
    const {t,urls}=tool([[/smartbox/,res('v_hint="sh~600519~\\u8d35\\u5dde\\u8305\\u53f0~gzmt~GP-A"')],[/qt\.gtimg\.cn\/q=sh600519/,res(tencentLine('sh600519','贵州茅台','1500.00','1490.00','20261103100458','10.00','0.67','1510.00','1488.00'))]]);
    const out=await t.run({target:'茅台'});
    expect(urls[0]).toContain('smartbox.gtimg.cn');expect(out).toContain('贵州茅台（sh600519）：1500 元，较昨收涨 0.67%（+10）');expect(out).toContain('行情时间 2026-11-03 10:04:58');
    expect(out).toContain('来源：腾讯行情 https://qt.gtimg.cn/q=sh600519');expect(out).toContain('取数时间 2026-11-03 10:05');expect(out).toContain('不是交易所逐笔成交');
  });
  it('金价：上海金元/克和伦敦金美元/盎司，并提醒金店价更高；一个来源失败另一个照给并写明未取到',async()=>{
    const {t}=tool([[/118\.AU9999/,res(JSON.stringify({data:{f43:952.3,f44:955,f45:948.1,f46:950,f58:'黄金9999',f60:949.5,f86:1793671200,f169:2.8,f170:0.29}}))]]);
    const out=await t.run({target:'金价'});
    expect(out).toContain('上海黄金交易所 Au99.99（118.AU9999）：952.3 元/克');expect(out).toContain('金店零售价');expect(out).toContain('未取到：伦敦金');
  });
  it('汇率：实时取不到时用每日参考汇率并写明不是实时',async()=>{
    const {t}=tool([[/er-api/,res(JSON.stringify({result:'success',time_last_update_utc:'Mon, 03 Nov 2026 00:02:31 +0000',rates:{CNY:7.1234}}))]]);
    const out=await t.run({target:'USD'});
    expect(out).toContain('1 USD 兑人民币（每日参考价）：7.1234 元');expect(out).toContain('一天更新一次');
  });
  it('美股整体：给三大指数；腾讯代码写法不认时换备用写法，再不行换东方财富',async()=>{
    const {t,urls}=tool([[/q=usDJI$/,res('v_pv_none_match="1";')],[/q=us\.DJI$/,res(tencentLine('us.DJI','道琼斯','47000.1','46800','2026-11-02 16:00:00','200.1','0.43','47100','46700'))],[/q=usIXIC$/,res(tencentLine('usIXIC','纳斯达克','23000','23100','2026-11-02 16:00:00','-100','-0.43','23200','22900'))],[/100\.SPX/,res(JSON.stringify({data:{f43:6800,f44:6810,f45:6780,f46:6790,f58:'标普500',f60:6790,f86:1793664000,f169:10,f170:0.15}}))]]);
    const out=await t.run({target:'美股'});
    expect(out).toContain('道琼斯');expect(out).toContain('纳斯达克（usIXIC）：23000，较昨收跌 0.43%');expect(out).toContain('标普500');
    expect(urls.some(u=>/us\.DJI/.test(u))).toBe(true);
  });
  it('全部来源失败抛出行情错误（流程退回搜索）；名字查不到要求给代码',async()=>{
    await expect(tool([]).t.run({target:'金价'})).rejects.toMatchObject({code:'NO_MARKET_DATA'});
    await expect(tool([[/smartbox/,res('v_hint="N"')]]).t.run({target:'不存在的公司'})).rejects.toMatchObject({code:'INVALID_QUOTE_INPUT'});
    await expect(tool([]).t.run({target:''})).rejects.toMatchObject({name:'ValidationError'});
  });
  it('腾讯原始GBK字节也能正确解出中文',async()=>{
    const gbk=Uint8Array.from([0xB9,0xF3,0xD6,0xDD,0xC3,0xA9,0xCC,0xA8]); // “贵州茅台”的GBK编码
    const line=tencentLine('sh600519','NAME','1500.00','1490.00','20261103100458','10.00','0.67','1510.00','1488.00');
    const [head,tail]=line.split('NAME');const enc=s=>new TextEncoder().encode(s);
    const bytes=new Uint8Array([...enc(head),...gbk,...enc(tail)]);
    const {t}=tool([[/qt\.gtimg/,{ok:true,status:200,text:async()=>'',arrayBuffer:async()=>bytes.buffer}]]);
    expect(await t.run({target:'sh600519'})).toContain('贵州茅台（sh600519）');
  });
  it('模型没来得及答时，兜底直接给报价回执',()=>{
    const d=createLookupDelivery('茅台股价');
    d.record({name:'get_market_quote',ok:true,output:'报价（取数时间 2026-11-03 10:05 北京时间）\n贵州茅台（sh600519）：1500 元，较昨收涨 0.67%（+10）\n来源：腾讯行情 https://qt.gtimg.cn/q=sh600519'});
    expect(d.text()).toContain('贵州茅台（sh600519）：1500 元');expect(d.hasResults).toBe(true);
  });
});
