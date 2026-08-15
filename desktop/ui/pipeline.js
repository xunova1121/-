/**
 * 流水线的七步，以及每一步的完成度。
 *
 * ── 为什么单独一个模块 ──
 *
 * 这份状态有两个地方要用：左边菜单里的那串步骤（带对勾），和创作台里
 * 当前这一步的详情面板。两处各算一遍的话，迟早会出现"菜单说完成了、
 * 面板说还差三张"这种自相矛盾 —— 而这种矛盾最消耗信任。
 *
 * ── 剧本为什么也算一步 ──
 *
 * 因为它就是一步：没有剧本，后面六步一步都跑不了。
 * 早先它是"创作台顶上的一个输入框"，于是整页从剧本一路铺到分镜网格，
 * 想点第 04 步得先滚过三屏。摆进流水线之后，每一步只显示这一步的东西。
 */

/** 服务端定义的阶段（store.STAGES）之外，剧本是界面这边加的第一步 */
export const SCRIPT_STEP = {
  id: 'script-src',
  label: '剧本',
  hint: '把小说片段、大纲或完整剧本贴进来。长篇先分章 —— 后面每一步都可以按章单独跑'
};

/** 完整步骤列表。跟着目录走，标签和提示语和服务端保持一份。 */
export function stepsOf(catalog) {
  const stages = (catalog?.stages || []).filter((s) => s.id !== 'export');
  return [SCRIPT_STEP, ...stages];
}

/**
 * 这一步做完了多少。
 *
 * done/total 是**看得见的产出**（几张图、几段视频），不是"跑没跑过" ——
 * 跑过但一半失败的，不该显示成完成。
 */
export function stepProgress(project, id) {
  const shots = project?.shots || [];
  const bible = project?.bible;
  switch (id) {
    case 'script-src': {
      const has = Boolean(project?.script?.trim());
      return { done: has ? 1 : 0, total: 1, unit: '份剧本' };
    }
    case 'bible': {
      const all = bible ? [...bible.characters, ...bible.scenes, ...(bible.props || [])] : [];
      return { done: all.filter((x) => x.sheetPath).length, total: all.length, unit: '张参考图' };
    }
    case 'script':
      return { done: shots.length, total: shots.length || 0, unit: '个分镜' };
    case 'assets':
      return { done: shots.filter((s) => s.imagePath).length, total: shots.length, unit: '张镜头图' };
    case 'video':
      return {
        done: shots.filter((s) => s.videoPath).length,
        total: shots.length,
        unit: '段视频',
        // 提交成功但取不回来的：既不算完成也不算失败，单独数一份
        pending: shots.filter((s) => s.pendingTask && !s.videoPath).length
      };
    case 'voice': {
      const need = shots.filter((s) => s.dialogue?.trim());
      return { done: need.filter((s) => s.audioPath).length, total: need.length, unit: '条配音' };
    }
    case 'compose':
      return { done: project?.outputs?.video ? 1 : 0, total: 1, unit: '支成片' };
    default:
      return { done: 0, total: 0, unit: '' };
  }
}

/**
 * 一步的状态：done / partial / pending。
 *
 * 判断依据是产出而不是 stageStatus 标记 —— 标记只说明"这一步跑过"，
 * 而对勾要回答的是"这一步齐了没有"。跑过但缺三张图，那就不是对勾。
 */
export function stepState(project, id) {
  const { done, total } = stepProgress(project, id);
  if (!total) return project?.stageStatus?.[id] === 'done' ? 'done' : 'pending';
  if (done >= total) return 'done';
  return done > 0 ? 'partial' : 'pending';
}
