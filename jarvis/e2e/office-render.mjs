import {inspectRenderedPdf} from '../src/agent/pdfQuality.js';
import {inspectDocument} from '../src/agent/documentQuality.js';
/** CI安装LibreOffice后验证三种真实产物转PDF，不跳过缺失渲染器。 */
import {generate} from '../src/agent/docs.js';
import {renderOffice,officeRenderAvailable} from '../server/officeRender.mjs';
if(!await officeRenderAvailable())throw new Error('真实Office验收需要LibreOffice，不能跳过');
for(const ext of ['docx','pptx','xlsx']){
 const content=ext==='xlsx'?'## 预算\n项目,金额\n研发,100\n测试,200':'# 项目汇报\n\n## 核心结论\n- 先核对资料，再形成可编辑的成品。\n\n## 计划\n- 明确负责人、时间与验收标准。';
 const artifact=await generate(ext,{title:'未央真实渲染验收',content});
 const result=await renderOffice(artifact.blob,ext);
 if(!result.available||result.blob.size<500||await result.blob.slice(0,5).text()!=='%PDF-')throw new Error(ext+'真实渲染失败');
 console.log('✓ '+ext+'由LibreOffice真实生成PDF，'+result.blob.size+'字节');
}

// 总页数必须同时经真实PPT包和LibreOffice输出PDF核对，不只相信生成器计数。
const slides = Array.from({length:5},(_,i)=>`## 场景${i+1}\n\n交易批次${i+1}保留完整称重、检测与交付记录。`).join('\n\n');
const five = await generate('pptx',{title:'五页验收',content:slides,expectedSlides:5});
const actual = await inspectDocument(five.blob,'五页验收.pptx',{info:five.info});
const preview = await renderOffice(five.blob,'pptx');
if(!preview.available)throw new Error('五页PPT真实渲染不可用，不能跳过');
const pdf = await inspectRenderedPdf(preview.blob);
if(actual.slides!==5||pdf.pages!==5)throw new Error(`五页约束失败：PPT ${actual.slides}，PDF ${pdf.pages}`);
console.log('✓ 五页PPT经真实Office转换后仍为五页PDF');
