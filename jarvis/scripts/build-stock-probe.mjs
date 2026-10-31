import fs from 'node:fs/promises';
const file='evals/stock-images-live.mjs';
const old=await fs.readFile(file,'utf8'),source=await fs.readFile('src/agent/stockImageSources.js','utf8');
const start=old.indexOf('/** 只用官方API'),end=old.indexOf('\nconst args=');
if(start<0||end<start)throw new Error('探测脚本边界失效');
await fs.writeFile(file,old.slice(0,start)+source.replaceAll('export ','')+old.slice(end));
