import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DEFAULT_CONFIG} from '../src/llm/config.js';
import {validateLiveConfig} from './baseline.mjs';
import {normalize} from '../src/agent/workspace.js';
const invalid=message=>Object.assign(new Error(message),{code:'ARCHITECTURE_TEST_INPUT'});
async function bounded(file,max){const info=await fs.stat(file);if(!info.isFile()||info.size>max)throw invalid('测试输入文件类型或大小不符合要求');return fs.readFile(file);}
/** 只读指定配置和一个确切工作区记录；不打开生产store写接口，不枚举正式对话或其他文件。 */
export async function architectureServerInput(dataDir,source){
 const root=await fs.realpath(dataDir);source=normalize(source);
 if(!source.endsWith('.docx')||source.length>400)throw invalid('请提供工作区内确切的原始DOCX路径');
 const cfg={...DEFAULT_CONFIG,...JSON.parse(await bounded(path.join(root,'config.json'),2e6))};
 const selected=validateLiveConfig(cfg);
 const hash=createHash('sha1').update(source).digest('hex');
 const folder=path.join(root,'store','files');
 const record=JSON.parse(await bounded(path.join(folder,hash+'.json'),100000));
 if(record.id!==source||record.data?.$file!==hash+'.data.bin')throw invalid('工作区原件记录不匹配，不能借其他文件替代');
 const file=await fs.realpath(path.join(folder,record.data.$file));
 if(path.dirname(file)!==await fs.realpath(folder))throw invalid('工作区原件不能指向目录外');
 const bytes=await bounded(file,10e6);
 if(bytes[0]!==0x50||bytes[1]!==0x4b)throw invalid('文件不是可读取的DOCX压缩包');
 return {cfg,selected,source,bytes};
}
