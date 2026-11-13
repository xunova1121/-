import {describe,it,expect} from 'vitest';
import * as agent from '../src/agent/agent.js';
import {lookupIntent,newsSubject} from '../src/agent/lookup/intent.js';
import {lookupPlan} from '../src/agent/lookup/plan.js';
import {offSubject} from '../src/agent/lookup/selfDrive.js';
import {scheduledPrompt} from '../src/agent/scheduledRun.js';
import {pageReaderOrder} from '../src/agent/pageReader.js';
import {lookupAnswerNote} from '../src/agent/lookup/answer.js';
import {createRetrievalBudget} from '../src/agent/lookup/clock.js';
// 用户 2026-11-02：问日本新闻，走了今日新闻汇总，拿回10条央广网国内报道就交差，还说“明天额度恢复后再查”
const getTool=name=>['get_today_news','web_search','get_stock_kline'].includes(name)?{name,input_schema:{properties:{categories:{items:{enum:['体育']}},date_mode:{}}}}:null;
const planOf=text=>lookupPlan(lookupIntent(text),{text,getTool});
describe('点名对象的新闻改走搜索，笼统概览才走汇总',()=>{
  it('国家地区、人物公司、事件、汇总以外领域、球队球员 → 搜索',()=>{
    for(const t of ['日本新闻','今天日本方面的新闻','马斯克最新动态','华为最新消息','阿曼苏丹访华新闻','汽车新闻','南京本地新闻','梅西伤病消息','NBA新闻'])expect(planOf(t)?.name,t).toBe('web_search');
  });
  it('今天有什么新闻、国内/国际/财经/科技新闻、体育资讯、定时新闻简报仍走汇总',()=>{
    for(const t of ['今日新闻','今天有什么新闻','国际新闻','最近有什么重要新闻','财经新闻','体育资讯','今日新闻，打开原文核实'])expect(planOf(t)?.name,t).toBe('get_today_news');
    const scheduled=scheduledPrompt({title:'每日重点新闻',prompt:'请搜索并整理今天的重点新闻，覆盖国内、国际、财经与科技，筛选5—8条，每条写明日期和原始来源链接'},'2026/11/2 10:00');
    expect(newsSubject(scheduled)).toBe('');
    expect(newsSubject(scheduledPrompt({title:'x',prompt:'日本新闻'},'w'))).toBe('日本');
  });
  it('没有证券代码的油价、金价、汇率走搜索，不交给股票日K工具',()=>{
    for(const t of ['今天油价多少','金价','美元兑人民币汇率','比特币价格'])expect(planOf(t)?.name,t).toBe('web_search');
  });
  it('结果里没有点名对象就算没查到；对象词按前两个字比对',()=>{
    expect(offSubject('央广网：国内某地开展秋收 https://news.cnr.cn/a.html','日本')).toBe(true);
    expect(offSubject('日本民间团体集会反对修宪 https://news.cn/a','日本')).toBe(false);expect(offSubject('没有链接的回执','日本')).toBe(false);
    expect(offSubject('韩国央行维持利率不变 https://a.cn/x','日本 韩国在')).toBe(false);
    expect(offSubject('任何内容','')).toBe(false);
  });
});
describe('拿回来的东西不相关时交给未央接着查',()=>{
  it('问日本新闻，第一次搜索只回国内报道：不交差，带着经过换办法再查',async()=>{
    let n=0;const events=[],seen=[];
    const tools=[
      {name:'web_search',description:'x',input_schema:{type:'object',properties:{query:{type:'string'}}},run:async({query})=>/site:|NHK|共同社/.test(query)?'- 日本民间团体集会反对修宪\n  https://www.news.cn/world/jp.html\n  11月2日，日本多地……':'- 央广网：国内秋收进展\n  https://news.cnr.cn/a.html\n  国内多地秋收……'},
      {name:'fetch_url',description:'x',input_schema:{type:'object',properties:{url:{type:'string'}}},run:async()=>'正文'}
    ];
    const adapter={async stream({messages,onText}){
      n++;seen.push(String(messages.at(-1).content));
      if(n===1)return {text:'',toolCalls:[{id:'a',name:'web_search',args:{query:'日本 新闻 NHK 共同社'}}],stop:'tool_use'};
      onText('日本：民间团体集会反对修宪（新华网）。');return {text:'日本：民间团体集会反对修宪（新华网）。',toolCalls:[],stop:'end_turn'};
    }};
    const r=await agent.runAgent({adapter,model:'m',history:[],userText:'日本新闻',tools,context:{memory:'',lessons:[],skills:[],summary:null,dynamic:''},emit:e=>events.push(e)});
    expect(seen[0]).toContain('已经试过');expect(seen[0]).toContain('日本');
    expect(events.some(e=>e.type==='tool_progress'&&/换办法接着查/.test(e.text))).toBe(true);
    expect(r.text).toContain('修宪');
  });
});
describe('说清依据，不编“额度明天恢复”；知道自己用的是哪家服务',()=>{
  it('收尾说明和查询说明都禁止说额度用完、明天再查',()=>{
    expect(createRetrievalBudget('日本新闻').note).toContain('额度用完');
    expect(lookupAnswerNote(lookupIntent('日本新闻'),'日本新闻')).toContain('明天再查');
  });
  it('读原文的服务顺序写进工具说明（只有名字，不带Key）',()=>{
    expect(pageReaderOrder({deepseekSearchEnabled:true,deepseekSearchKey:'sk-secret',tavilyKey:''})).toBe('DeepSeek Fetch（最多等8秒） → 服务器/本机直接打开网页');
    expect(pageReaderOrder({deepseekSearchEnabled:true,deepseekSearchKey:'sk-secret'})).not.toContain('sk-');
    expect(pageReaderOrder({})).toBe('服务器/本机直接打开网页');
  });
});
