// 原创生成器：运行已核验MIT许可的6tail/lunar-javascript，提取1900～2100年历表。
// 来源 https://github.com/6tail/lunar-javascript ，lunar.js blob 355b7bcd6fcc773b79e8bd179f0df3c5fb73a4f1。
// 版权及MIT许可完整保留在 src/agent/lunarTable.LICENSE；仅开发时生成，不引入运行依赖。
// 用法：node scripts/make-lunar-table.mjs /path/to/verified-lunar.cjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
const require = createRequire(import.meta.url);
if (!process.argv[2]) throw new Error('请提供上述已核验源文件的本地路径');
const source = fs.readFileSync(path.resolve(process.argv[2]));
const blob = createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
if (blob !== '355b7bcd6fcc773b79e8bd179f0df3c5fb73a4f1') throw new Error('源文件与固定的已核验版本不同，停止生成；不能沿用旧来源标记');
const { LunarYear, Lunar } = require(path.resolve(process.argv[2]));
const rows = [];
const qingming = [];
for (let year = 1900; year <= 2100; year++) {
  const months = LunarYear.fromYear(year).getMonths().filter(month => month.getYear() === year);
  rows.push([year, Lunar.fromYmd(year, 1, 1).getSolar().toYmd(), -(months.find(month => month.getMonth() < 0)?.getMonth() || 0), months.map(month => month.getDayCount())]);
  qingming.push(Lunar.fromYmd(year, 1, 1).getJieQiTable()['清明'].toYmd());
}
if (rows.length !== 201 || rows.some(row => row[3].some(days => days !== 29 && days !== 30))) throw new Error('农历数据不完整');
const license = fs.readFileSync(new URL('../src/agent/lunarTable.LICENSE', import.meta.url), 'utf8');
fs.writeFileSync(new URL('../src/agent/lunarTable.js', import.meta.url), `/*! 6tail/lunar-javascript — ${license} */\n// 由 scripts/make-lunar-table.mjs 生成，依据 6tail/lunar-javascript（MIT，Copyright (c) 2018 6tail）。
// 来源 https://github.com/6tail/lunar-javascript ，源blob 355b7bcd6fcc773b79e8bd179f0df3c5fb73a4f1。
// 完整许可见 lunarTable.LICENSE；转换算法为本项目独立实现，不依赖运行时ICU农历。
// 行：[农历年, 正月初一公历, 闰月(0表示无), 按顺序的月份天数]，覆盖1900～2100年。
export const LUNAR_TABLE = [\n${rows.map(row => '  ' + JSON.stringify(row)).join(',\n')}\n];\n// 清明是节气，独立于放假调休安排；按1900年至2100年顺序。\nexport const QINGMING_DATES = ${JSON.stringify(qingming)};\n`);
