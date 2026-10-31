/**
 * 项目规则文件：工作区根目录的“未央规则.md”（也认 AGENTS.md），每轮自动读进上下文。
 * 用户在里面写这个项目的长期规矩（用什么格式、文件放哪、称呼、禁忌），不用每次对话重复说。
 * 用户说“以后都要……/记进项目规则”时，未央用 edit_file / write_file 改这个文件。
 */
import * as ws from './workspace.js';

export const RULE_FILES = ['未央规则.md', 'AGENTS.md'];
export const RULES_MAX = 6000; // 太长会挤占每轮的上下文，超出部分让模型自己去读

/** @returns {Promise<{ path: string, text: string, truncated: boolean } | null>} */
export async function loadRules({ readText = ws.readText, exists = ws.exists, max = RULES_MAX } = {}) {
  for (const path of RULE_FILES) {
    try {
      if (!(await exists(path))) continue;
      const text = String(await readText(path)).replace(/^﻿/, '').trim();
      if (!text) continue;
      return { path, text: text.slice(0, max), truncated: text.length > max };
    } catch { /* 读不到就当没有 */ }
  }
  return null;
}

/** 放进上下文的一段 */
export function rulesBlock(rules) {
  if (!rules) return '';
  return `## 项目规则（工作区 ${rules.path}，用户写的长期规矩：照着做，优先于默认做法；和用户这次说的冲突时以这次为准）\n${rules.text}${rules.truncated ? `\n…（规则较长，后面的内容用 read_file 读 ${rules.path}）` : ''}`;
}
