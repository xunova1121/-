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
import { normalizeBible } from './pipeline/variants.js';

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

/**
 * ⚠ 大纲是**正式一步**，插在设定集和分镜之间。
 *
 * 它原来不在这个列表里 —— 只是「分镜」那一步里的一个面板。后果是：
 *   · 新用户根本看不到它
 *   · 而它恰恰是长剧本唯一的出路（拆分镜按场次分批，靠的就是它）
 *   · 于是我们只能在**报错里**教育"先出大纲再拆分镜"——
 *     要靠报错来教的东西，本身就是摆错了位置
 *
 * 插在分镜正前方而不是排到最前，是因为它就是给分镜用的；
 * 也不打乱大家已经习惯的"剧本 → 设定集"这个开头。
 */
export const STAGES = ['bible', 'outline', 'script', 'assets', 'video', 'voice', 'compose', 'export'];

export const STAGE_LABELS = {
  bible: '设定集',
  outline: '大纲',
  script: '分镜',
  assets: '镜头出图',
  video: '视频生成',
  voice: '配音',
  compose: '合成',
  export: '导出'
};

export const STAGE_HINTS = {
  bible: '冻结角色与场景外貌，并出参考图 —— 后面所有镜头都引用它，这是一致性的地基。不满意就在下面的设定集里改描述、单独重出那一张',
  outline: '一行一场戏 —— 剧本和分镜之间可以商量的那一层。在这儿改一句话，比拆完分镜再去改十几行省事得多；'
    + '而且拆分镜会**按场次分批**，每批只写几场，多长的剧本都不会撞模型一次能写的上限',
  script: '按已冻结的设定拆分镜，分镜里只写画面不写外貌',
  assets: '逐镜出图，自动带上参考图并做一致性复核，不达标会重试',
  video: '以镜头图为首帧生成视频片段',
  voice: '按台词合成配音',
  compose: 'FFmpeg 拼接成片',
  export: '导出到项目目录'
};

export function create({
  title = '未命名项目',
  script = '',
  style = '',
  styleId = 'ink',
  targetDuration = 60,
  aspectRatio = ''
} = {}) {
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
    /** 目标成片时长（秒）。这是输入，不是结果 —— 分镜数由它反推。 */
    targetDuration: Number(targetDuration) || 60,
    /**
     * 画幅。**属于这一部片子**，不是全局设置 ——
     * 一个人手上同时有横屏宣传片和竖屏短剧是常事，
     * 挂在设置里就意味着每次切项目都得记得回去改一次，迟早出错。
     * 留空表示跟随「设置 → 画幅」。
     */
    aspectRatio: aspectRatio || '',
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
  let project;
  try {
    project = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
  } catch {
    return null;
  }
  /**
   * 补上缺的阶段键。
   *
   * 中途试过把「设定集」拆成「描述」+「出图」两步，后来又合了回去 ——
   * 那段时间存下来的项目里带着一个 sheets 键，而现在的阶段列表没有它。
   * 缺键会让阶段轨上那一格永远显示"未开始"，多的键则没人读，留着无害。
   * 在**读的时候**补而不是去改老文件：迁移脚本跑一半失败会留下半新半旧的数据，
   * 而这种补法每次读都幂等。
   */
  const st = project.stageStatus || (project.stageStatus = {});
  for (const stage of STAGES) if (st[stage] === undefined) st[stage] = 'pending';

  // 设定集条目补上"变体"这一层（老项目没有）。同样是读时补、幂等，
  // 补出来的默认变体直接接管条目原有的那张设定图。见 pipeline/variants.js
  normalizeBible(project.bible);
  return project;
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
      // 项目页要显示画风和时长，不然一列同名项目根本分不出谁是谁
      styleId: p.styleId || 'ink',
      style: p.style || '',
      aspectRatio: p.aspectRatio || '',
      targetDuration: p.targetDuration || 0,
      chapters: p.chapters?.length || 0,
      hasBible: Boolean(p.bible),
      videos: p.shots?.filter((s) => s.videoPath).length || 0,
      images: p.shots?.filter((s) => s.imagePath).length || 0,
      output: Boolean(p.outputs?.video),
      stageStatus: p.stageStatus
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/**
 * 删项目。
 *
 * Windows 上删文件夹远没有 Linux 上那么听话：只要还有人开着里面的文件
 * （界面上正在播的那段 mp4、正在显示的那张图，都算），就会抛 EBUSY / EPERM。
 * 早期版本直接 rmSync 一把梭，遇到占用就整条请求 500，
 * 界面上什么都不变 —— 于是看起来"删不掉，非得重启"。
 *
 * 两处改动：
 *   ① 带重试：Node 的 maxRetries/retryDelay 专门对付这种短暂占用，
 *      浏览器一松手（界面在发请求前会先清掉 src）通常第二次就过了；
 *   ② 先删 project.json：万一 assets 里某个文件死活删不掉，
 *      项目也已经从列表里消失了，不会留一个点开就报错的僵尸条目。
 *      剩下的目录下次启动时顺手清掉。
 */
export function remove(id) {
  const dir = dirOf(id);
  if (!fs.existsSync(dir)) return true;

  try {
    fs.rmSync(fileOf(id), { force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* project.json 都删不掉的话，下面整目录删一次还有机会 */
  }

  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch (err) {
    // 目录还在但 project.json 已经没了 —— 列表里看不到它，功能上已经算删掉了。
    // 如实说一声，别假装什么都没发生，也别让整个请求失败。
    return { ok: true, leftover: dir, reason: err.message };
  }
  return true;
}

/**
 * 清理残骸：没有 project.json 的项目目录。
 * 上一次删除被文件占用打断时会留下这种目录，启动时顺手扫一遍就干净了。
 */
export function sweepOrphans() {
  ensureDirs();
  let swept = 0;
  for (const d of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    if (fs.existsSync(path.join(PROJECTS_DIR, d.name, 'project.json'))) continue;
    try {
      fs.rmSync(path.join(PROJECTS_DIR, d.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      swept += 1;
    } catch {
      /* 还占着就下次再说，不值得为它拦住启动 */
    }
  }
  return swept;
}

export function assetDir(id) {
  const dir = path.join(dirOf(id), 'assets');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function projectDir(id) {
  return dirOf(id);
}
