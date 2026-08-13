/**
 * 项目存储：一个项目 = %APPDATA%\FutureDream\projects\<id>\project.json + 同目录的产物。
 *
 * 刻意用"一个项目一个文件夹"的朴素结构，不上数据库：
 * 用户可以直接把整个文件夹拷给同事，或者出问题时手动改 JSON 救回来。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECTS_DIR, ensureDirs, safeFileName } from './paths.js';

function dirOf(id) {
  return path.join(PROJECTS_DIR, id);
}

function fileOf(id) {
  return path.join(dirOf(id), 'project.json');
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

export const STAGES = ['bible', 'script', 'assets', 'video', 'voice', 'compose', 'export'];

export const STAGE_LABELS = {
  bible: '设定集',
  script: '分镜',
  assets: '镜头出图',
  video: '视频生成',
  voice: '配音',
  compose: '合成',
  export: '导出'
};

export const STAGE_HINTS = {
  bible: '冻结角色与场景外貌，并出参考图 —— 后面所有镜头都引用它，这是一致性的地基',
  script: '按已冻结的设定拆分镜，分镜里只写画面不写外貌',
  assets: '逐镜出图，自动带上参考图并做一致性复核，不达标会重试',
  video: '以镜头图为首帧生成视频片段',
  voice: '按台词合成配音',
  compose: 'FFmpeg 拼接成片',
  export: '导出到项目目录'
};

export function create({ title = '未命名项目', script = '', style = '', styleId = 'ink' } = {}) {
  ensureDirs();
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const project = {
    id,
    title: safeFileName(title, '未命名项目'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    script,
    /** 选中的画风预设 id，见 core/styles.js */
    styleId,
    /** 在预设之上补充的自定义描述（预设选 custom 时这里就是全部） */
    style,
    logline: '',
    /**
     * 章节。长篇必须拆，否则一次几万字会超上下文、也没法中途重来。
     * 但**设定集不拆**：它挂在项目上，全部章节共享同一份 ——
     * 每章各自生成人设的话，第二章的角色就换脸了。
     * 空数组表示短片模式，剧本直接放 project.script。
     */
    chapters: [],
    /** 冻结的设定集：{ style, characters[], scenes[], props[] }，见 pipeline/consistency.js */
    bible: null,
    shots: [],
    stageStatus: Object.fromEntries(STAGES.map((s) => [s, 'pending'])),
    outputs: {}
  };
  fs.mkdirSync(path.join(dirOf(id), 'assets'), { recursive: true });
  writeAtomic(fileOf(id), JSON.stringify(project, null, 2));
  return project;
}

export function read(id) {
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
  } catch {
    return null;
  }
}

export function save(project) {
  project.updatedAt = new Date().toISOString();
  fs.mkdirSync(dirOf(project.id), { recursive: true });
  writeAtomic(fileOf(project.id), JSON.stringify(project, null, 2));
  return project;
}

export function update(id, mutator) {
  const project = read(id);
  if (!project) throw new Error(`项目不存在：${id}`);
  const next = mutator(project) || project;
  return save(next);
}

export function list() {
  ensureDirs();
  return fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => read(d.name))
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      title: p.title,
      updatedAt: p.updatedAt,
      shots: p.shots?.length || 0,
      stageStatus: p.stageStatus
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function remove(id) {
  fs.rmSync(dirOf(id), { recursive: true, force: true });
  return true;
}

export function assetDir(id) {
  const dir = path.join(dirOf(id), 'assets');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function projectDir(id) {
  return dirOf(id);
}
