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
