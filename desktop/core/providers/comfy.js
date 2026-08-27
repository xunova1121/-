/**
 * 本地出图：ComfyUI。
 *
 * ════════ 为什么值得接 ════════
 *
 * 别的服务商都是"发提示词、付钱、拿回什么算什么"。ComfyUI 跑在你自己的
 * 显卡上，于是有两件别处做不到的事：
 *
 *   · **重出不花钱**。改一句描述试五十次，成本是零。这直接改变用法 ——
 *     现在每按一次「重出」都是钱，人会犹豫，而犹豫的结果是将就
 *   · **一致性可以硬来**。我们现在的第③层是"发参考图"，而那是**求厂商照办**
 *     （所以才有 headMatch 那条检查去抓"这家没吃参考图"）。
 *     ComfyUI 那边可以上 IPAdapter / ControlNet / LoRA —— 那不是求它，
 *     是让它做不到别的。完全不同量级的手段
 *
 * ════════ 工作流是用户自己的 ════════
 *
 * 这是这个适配器和别家最大的不同：**我们不知道用户的工作流长什么样**。
 * 有人用 SDXL、有人用 Flux，有人挂三个 LoRA 加 ControlNet。
 * 硬塞一个我们自己的工作流进去，等于把 ComfyUI 最值钱的部分（可定制）扔掉。
 *
 * 所以做法是：**用户把自己的工作流导出成 API 格式贴进来**，
 * 在要我们填的那几个节点上改个标题（ComfyUI 里双击节点标题就能改）：
 *
 *   FD_PROMPT    正向提示词填这儿
 *   FD_NEGATIVE  反向提示词（可选）
 *   FD_SEED      种子（可选，不给就用工作流里原来那个）
 *   FD_SIZE      出图尺寸（可选，节点要有 width/height 输入）
 *   FD_REF       参考图（可选，要是一个 LoadImage 节点）
 *
 * ⚠ 找不到标记时**当场报错，不要默默跑**。
 * 默默跑的结果是：出图成功、不花钱、而画的完全是工作流里写死的那句提示词 ——
 * 你改一百遍描述都没反应，而且没有任何报错。这是这个适配器最容易坏的地方，
 * 所以每一条缺失都点名说清楚该去哪儿改。
 */

import { execute, executeJSON, poll, HttpError } from '../http-client.js';

/** 我们往工作流里填东西的那几个标记。用户在 ComfyUI 里改节点标题来打这些标记 */
export const MARKERS = {
  prompt: 'FD_PROMPT',
  negative: 'FD_NEGATIVE',
  seed: 'FD_SEED',
  size: 'FD_SIZE',
  ref: 'FD_REF'
};

/** 每个标记该往节点的哪个输入里塞。挨个试，第一个存在的就用它 */
const SLOTS = {
  prompt: ['text', 'prompt', 'string', 'value'],
  negative: ['text', 'prompt', 'string', 'value'],
  seed: ['seed', 'noise_seed'],
  ref: ['image']
};

/**
 * 找出打了某个标记的节点。
 *
 * ComfyUI 的 API 格式里，节点标题在 `_meta.title`。
 * 用户没改标题时那儿是节点的类名（"CLIPTextEncode"），不会误撞我们的标记。
 */
function findTagged(workflow, marker) {
  for (const [id, node] of Object.entries(workflow || {})) {
    const title = String(node?._meta?.title || '').trim();
    if (title === marker || title.startsWith(`${marker} `)) return { id, node };
  }
  return null;
}

function setSlot(node, keys, value, what) {
  if (!node.inputs || typeof node.inputs !== 'object') node.inputs = {};
  for (const k of keys) {
    if (k in node.inputs) {
      node.inputs[k] = value;
      return k;
    }
  }
  throw new Error(
    `标着 ${what} 的那个节点上找不到能填${what === MARKERS.seed ? '种子' : '内容'}的输入`
    + `（试过 ${keys.join(' / ')}）。多半是标记打在了错的节点上 —— `
    + `${what === MARKERS.prompt || what === MARKERS.negative
      ? '它应该打在文本编码节点（CLIPTextEncode 那一类）上'
      : what === MARKERS.ref ? '它应该打在 LoadImage 节点上' : '换一个有这个输入的节点'}`
  );
}

/**
 * 把我们的东西填进用户的工作流。**不改传进来那份** —— 同一份工作流要用很多次。
 *
 * 回 { workflow, filled, skipped }：
 *   filled   真的填进去了哪几样
 *   skipped  工作流里没打这个标记，所以没填。**这个必须报上去** ——
 *            "种子没生效"和"种子生效了但结果一样"是两件完全不同的事
 */
export function inject(workflow, { prompt, negative, seed, width, height, refName } = {}) {
  const wf = JSON.parse(JSON.stringify(workflow));
  const filled = [];
  const skipped = [];

  /**
   * ⚠ 正向提示词是**必须**的，找不到就报错，不能跳过。
   *
   * 跳过的后果：出图成功、不花钱、画的是工作流里写死的那句话。
   * 你改一百遍画面描述都没反应，而且不报任何错 —— 这是这条路上
   * 最坏的一种坏法，因为它看起来完全正常。
   */
  const pNode = findTagged(wf, MARKERS.prompt);
  if (!pNode) {
    throw new Error(
      `工作流里没有标着 ${MARKERS.prompt} 的节点 —— 我们的画面描述没地方填。`
      + `去 ComfyUI 里双击正向提示词那个节点的标题，改成 ${MARKERS.prompt}，`
      + '然后重新导出「API 格式」的工作流贴回来。'
      + '（不报这个错的话：图能出、不花钱、而画的一直是工作流里写死的那句话，改描述毫无反应。）'
    );
  }
  setSlot(pNode.node, SLOTS.prompt, String(prompt ?? ''), MARKERS.prompt);
  filled.push('提示词');

  const nNode = findTagged(wf, MARKERS.negative);
  if (nNode && negative) {
    setSlot(nNode.node, SLOTS.negative, String(negative), MARKERS.negative);
    filled.push('反向提示词');
  } else if (negative) {
    skipped.push(`反向提示词（工作流里没有 ${MARKERS.negative}）`);
  }

  const sNode = findTagged(wf, MARKERS.seed);
  if (sNode && seed !== null && seed !== undefined) {
    setSlot(sNode.node, SLOTS.seed, Number(seed), MARKERS.seed);
    filled.push('种子');
  } else if (seed !== null && seed !== undefined) {
    /**
     * ⚠ 种子填不进去要说出来。
     *
     * 一致性复核不过时我们会**换个种子重试**（同种子会复现同一个错）。
     * 种子没生效的话，三次重试会出三张一模一样的图，而日志上写着"换了种子重试" ——
     * 白花三次时间，且看不出为什么。
     */
    skipped.push(`种子（工作流里没有 ${MARKERS.seed}，重试时换种子不会生效）`);
  }

  const zNode = findTagged(wf, MARKERS.size);
  if (zNode && width && height) {
    if (!zNode.node.inputs || !('width' in zNode.node.inputs) || !('height' in zNode.node.inputs)) {
      throw new Error(
        `标着 ${MARKERS.size} 的节点上没有 width / height 输入 —— `
        + '它应该打在空 Latent（EmptyLatentImage 那一类）节点上。'
      );
    }
    zNode.node.inputs.width = Number(width);
    zNode.node.inputs.height = Number(height);
    filled.push('尺寸');
  } else if (width && height) {
    skipped.push(`出图尺寸（工作流里没有 ${MARKERS.size}，用的是工作流自己那个尺寸）`);
  }

  const rNode = findTagged(wf, MARKERS.ref);
  if (rNode && refName) {
    setSlot(rNode.node, SLOTS.ref, refName, MARKERS.ref);
    filled.push('参考图');
  } else if (refName) {
    skipped.push(`参考图（工作流里没有 ${MARKERS.ref}，这一镜的一致性只剩提示词撑着）`);
  }

  return { workflow: wf, filled, skipped };
}

/** 解析用户贴进来的工作流。错在哪要说清楚 —— 这是最容易贴错的一步 */
export function parseWorkflow(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('还没有设置 ComfyUI 工作流 —— 去「设置 → 本地出图」把它贴进来');
  let wf;
  try {
    wf = JSON.parse(raw);
  } catch (err) {
    throw new Error(`工作流不是合法的 JSON：${err.message}`);
  }
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) {
    throw new Error('工作流应该是一个对象（节点号 → 节点）');
  }
  /**
   * ⚠ 认一下是不是**导错了格式**。
   *
   * ComfyUI 有两种导出：「工作流」（带 nodes / links，是给编辑器用的）
   * 和「API 格式」（节点号 → {class_type, inputs}，是给接口用的）。
   * 贴错的人会很多，而贴错之后的报错本来是一句莫名其妙的
   * "prompt 里没有节点" —— 直接点名说清楚省很多事。
   */
  if (Array.isArray(wf.nodes) || Array.isArray(wf.links)) {
    throw new Error(
      '这是「工作流」格式，接口要的是「API 格式」。'
      + '在 ComfyUI 里用 工作流 → 导出（API），把导出的那份贴进来。'
    );
  }
  const nodes = Object.values(wf);
  if (!nodes.length || !nodes.some((n) => n && typeof n === 'object' && n.class_type)) {
    throw new Error('工作流里一个节点都没有（每个节点应该有 class_type）');
  }
  return wf;
}

/** 工作流里打了哪几个标记 —— 设置页贴完当场告诉他，不用等到出图才发现 */
export function markersIn(workflow) {
  const out = {};
  for (const [key, marker] of Object.entries(MARKERS)) {
    out[key] = Boolean(findTagged(workflow, marker));
  }
  return out;
}

/**
 * 把一张图传给 ComfyUI（参考图要先传上去，LoadImage 才读得到）。
 *
 * multipart 是手搓的：这个项目零第三方依赖，而 Node 自带的 FormData
 * 在旧版本上行为不一致。手搓的好处是完全可控，坏处是要自己记得
 * 边界串不能出现在内容里 —— 用随机串规避。
 */
export async function uploadImage(baseUrl, bytes, filename, { onEvent } = {}) {
  const boundary = `----fd${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const head = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n`
    + 'Content-Type: image/png\r\n\r\n'
  );
  // overwrite=true：同名直接覆盖，免得 ComfyUI 那边攒出一堆 ref (1).png
  const tail = Buffer.from(
    `\r\n--${boundary}\r\n`
    + 'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n'
    + `--${boundary}--\r\n`
  );
  const body = Buffer.concat([head, Buffer.from(bytes), tail]);

  const res = await execute({
    provider: 'comfyui',
    label: '上传参考图',
    url: `${baseUrl}/upload/image`,
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
    timeoutMs: 60000
  }, onEvent);
  const name = res.json?.name;
  if (!name) throw new Error(`ComfyUI 没有收下这张参考图：${JSON.stringify(res.json).slice(0, 160)}`);
  return res.json.subfolder ? `${res.json.subfolder}/${name}` : name;
}

/**
 * 提交一次出图，等它跑完，回图片地址。
 *
 * ComfyUI 是排队跑的：提交拿 prompt_id，然后轮询 /history/<id>。
 * 本地跑一张图几秒到几分钟都可能（取决于显卡和步数），所以超时给得宽。
 */
export async function run(baseUrl, workflow, { timeoutMs = 600000, signal = null, onEvent } = {}) {
  const clientId = `fd-${Math.random().toString(36).slice(2)}`;
  let submitted;
  try {
    submitted = await executeJSON({
      provider: 'comfyui',
      label: '提交出图',
      url: `${baseUrl}/prompt`,
      method: 'POST',
      body: { prompt: workflow, client_id: clientId },
      timeoutMs: 60000
    });
  } catch (err) {
    /**
     * ⚠ 校验不过时 ComfyUI 回的是 400 + { error, node_errors }，
     * 而 **node_errors 里才写着到底哪个节点缺什么**。
     *
     * executeJSON 在非 2xx 时直接抛，只把 error.message 拼进消息里 ——
     * 于是用户拿到的是一句 "Prompt outputs failed validation"，
     * 完全不知道该去改哪个节点。把 node_errors 挖出来说清楚。
     */
    const detail = nodeErrorDetail(err?.bodyText);
    throw new Error(`ComfyUI 不收这个工作流：${err.message}${detail ? `。${detail}` : ''}`);
  }

  const promptId = submitted?.prompt_id;
  if (!promptId) {
    throw new Error(
      `ComfyUI 收下了却没给任务号：${JSON.stringify(submitted || null).slice(0, 160)}`
    );
  }
  onEvent?.({ type: 'note', message: `ComfyUI 排上队了（${promptId}），本地出图不花钱` });

  const done = await poll(async () => {
    const r = await executeJSON({
      provider: 'comfyui',
      label: '等出图',
      url: `${baseUrl}/history/${promptId}`,
      method: 'GET',
      timeoutMs: 30000
    });
    const entry = r?.[promptId];
    // ⚠ poll 的约定是回 { done, value }，不是"回了东西就算完"。
    // 回裸对象的话它永远不结束 —— 而表现是"一直在转"，看不出是约定用错了
    if (!entry) return { done: false, value: null }; // 还在队里
    const status = entry.status || {};
    if (status.status_str === 'error' || status.completed === false) {
      const msgs = (status.messages || [])
        .filter((m) => Array.isArray(m) && /error/i.test(String(m[0])))
        .map((m) => JSON.stringify(m[1]).slice(0, 200));
      throw new Error(`ComfyUI 跑失败了：${msgs.join(' / ') || '它没说原因，去 ComfyUI 那个窗口看控制台'}`);
    }
    return { done: true, value: entry };
  }, { intervalMs: 2000, timeoutMs, signal, taskId: promptId, onTick: ({ attempt }) => {
    if (attempt % 5 === 0) onEvent?.({ type: 'note', message: `ComfyUI 还在跑（第 ${attempt} 次查）` });
  } });

  /**
   * 从产物里挑出图片。
   *
   * ⚠ 只认 SaveImage / PreviewImage 那一类真的产出图片的节点。
   * 工作流里可能同时有存 latent、存文本的节点，全收的话会拿到不是图的东西。
   */
  const outputs = done?.outputs || {};
  for (const node of Object.values(outputs)) {
    const img = (node?.images || [])[0];
    if (!img?.filename) continue;
    const q = new URLSearchParams({
      filename: img.filename,
      subfolder: img.subfolder || '',
      type: img.type || 'output'
    });
    return { url: `${baseUrl}/view?${q}`, promptId };
  }
  throw new Error(
    '工作流跑完了，但没有产出图片 —— 多半是缺一个 SaveImage 节点。'
    + '（ComfyUI 里预览节点也算，但工作流末端必须有一个输出图像的节点。）'
  );
}

/**
 * 从 ComfyUI 的错误响应里挖出"哪个节点缺什么"。
 *
 * 它把这件事放在 node_errors 里，而顶层 error.message 永远是那句
 * 没有信息量的 "Prompt outputs failed validation"。
 */
function nodeErrorDetail(bodyText) {
  if (!bodyText) return '';
  let payload;
  try { payload = JSON.parse(bodyText); } catch { return ''; }
  const nodeErrs = payload?.node_errors || {};
  return Object.entries(nodeErrs)
    .map(([id, v]) => {
      const msgs = (v?.errors || []).map((x) => x.message).filter(Boolean).join('；');
      return `节点 ${id}：${msgs || JSON.stringify(v).slice(0, 80)}`;
    })
    .join(' / ');
}

/** 探活：设置页点「测试连通」走这条。ComfyUI 不需要密钥，所以只看通不通 */
export async function probe(baseUrl) {
  try {
    const r = await executeJSON({
      provider: 'comfyui', label: '连通性', url: `${baseUrl}/system_stats`, method: 'GET', timeoutMs: 8000
    });
    const dev = r?.devices?.[0];
    return {
      ok: true,
      detail: dev
        ? `${dev.name || '未知设备'}${dev.vram_total ? `，显存 ${Math.round(dev.vram_total / 1073741824)}G` : ''}`
        : 'ComfyUI 在'
    };
  } catch (err) {
    if (err instanceof HttpError && err.status) {
      return { ok: false, detail: `ComfyUI 回了 ${err.status} —— 地址对吗？` };
    }
    return { ok: false, detail: err.message };
  }
}
