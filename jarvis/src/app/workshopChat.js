import { localMinute } from '../core/localClock.js';
import { getWorkshopLife, dispatchWorkshopCommand } from './workshopLife.js';
import { selectWorkshopChannel } from '../ui/workshopMediaChannels.js';
import { playWorkshopHum, stopWorkshopHum, suggestWorkshopTune, workshopHumTitle } from '../ui/workshopHum.js';

// 只接本人对未央房间说的完整短句，保留搜索、生成音乐、文档内容与真实文件管理的原有路由。
const actions = [
  [
    'lamp-on',
    /^(?:打开|开启|开)(?:(?:工作台|工作室|房间)里?的?)?(?:那盏|你的|桌上的)?(?:台灯|灯光|灯)$|^把(?:(?:工作台|工作室|房间)里?的|桌上的|你的)?(?:台灯|灯)(?:打开|开亮)$/
  ],
  [
    'lamp-off',
    /^(?:关闭|关掉|关)(?:(?:工作台|工作室|房间)里?的?)?(?:那盏|你的|桌上的)?(?:台灯|灯光|灯)$|^把(?:(?:工作台|工作室|房间)里?的|桌上的|你的)?(?:台灯|灯)(?:关掉|关上|关了|关闭)$/
  ],
  ['lamp-auto', /^(?:恢复自动灯光|灯光跟随作息|台灯调回自动)$/],
  ['auto', /^(?:恢复(?:自己的|自动)?作息|按作息来)$/],
  ['coffee', /^(?:给自己|自己)?(?:去)?(?:泡|冲|煮)(?:一杯|个|杯|点)?咖啡$/],
  ['eat', /^(?:去|自己)?吃(?:早饭|午饭|晚饭|早餐|午餐|晚餐|饭)$/],
  ['rest', /^(?:去)?(?:休息|歇)(?:一会儿?|会儿?|一下)?$/],
  ['sleep', /^(?:去)?(?:睡觉|睡个觉|睡一觉|打个盹|睡一会儿?)$/],
  ['tv', /^(?:去)?看(?:一会儿?|会儿?)?电视$/],
  ['tv-off', /^(?:关|关掉|关闭)(?:(?:工作台|房间)(?:里)?的)?电视(?:机)?$|^把电视(?:机)?(?:关掉|关了|关闭|关上)$/],
  ['think', /^(?:去)?(?:发(?:会儿?|一会儿?|个)?呆|沉思(?:一会儿?|会儿?)?)$/],
  ['sing', /^(?:(?:给我|我想听你)?(?:哼(?:一?[支段首]|个)?(?:小曲儿?|曲子|歌)|唱(?:一?首|个)?歌)(?:听听)?|在(?:房间|工作台|工作室)(?:里)?唱(?:一?首|个)?歌)$/],
  [
    'shred',
    /^(?:用碎纸机)?(?:把)?(?:桌上(?:的)?|房间(?:里|的)?的?)?(?:这张|那张|一张)?废纸(?:放进碎纸机|送进碎纸机|碎掉|粉碎|销毁)$|^(?:粉碎|销毁|碎掉)(?:桌上的|房间里的)?(?:这张|那张)?废纸$/
  ]
];

export function workshopCommand(text) {
  if (typeof text !== 'string' || text.length > 52) return null;
  const phrase = text
    .trim()
    .replace(/[。！!?？~～]+$/u, '')
    .replace(/^(?:小?未央[，,、\s]*)?(?:请你|请|麻烦你|你能不能|能不能)?(?:你先|你)?/u, '')
    .trim();
  if (/^(?:现在你?)?在(?:干嘛|干什么|做什么|忙什么)(?:呢|呀|啊)?$|^(?:工作台|房间)(?:里)?(?:现在)?(?:在做什么|什么状态)$/u.test(phrase)) return 'status';
  if (/^(?:现在|这里|小屋里?|工作台上?)?(?:是)?几点(?:钟|了|啦)?$|^今天(?:是)?(?:几号|星期几|周几)$/u.test(phrase)) return 'clock';
  const command = phrase.replace(/(?:一下吧|一下下|好吗|好不好|吧|哦|啦)$/u, '').replace(/(打开|关掉|关闭|泡|冲|开|关)一下/u, '$1');
  return actions.find(([, matches]) => matches.test(command))?.[0] ?? null;
}

export function workshopMediaReply(text) {
  const phrase = text
    .trim()
    .replace(/^(?:小?未央[，,、\s]*)?(?:请你|请|麻烦你)?/u, '')
    .replace(/[！。!?？]+$/u, '');
  if (/^(?:刚才|现在|刚刚)?(?:电视(?:里|上)?|这个频道)(?:刚才|现在|刚刚)?(?:播了什么|在播什么|说了什么|讲了什么|在说什么)$/u.test(phrase))
    return '我目前能帮你选台和打开官方直播。这里没有节目字幕，无法核实刚才播出的内容。你也可以告诉我关键词，我来查相关报道。';
  if (!/^(?:把电视)?(?:换|切|切换|调|转)(?:到|成|至).{1,18}$/u.test(phrase)) return '';
  const channel = selectWorkshopChannel(phrase);
  return channel ? '工作台电视已选中 ' + channel.label + '。' : '';
}

// 返回本机实况，房间动作不创建模型任务或碰文件空间。
export function answerWorkshopCommand(command, { busy, otherWork, taskTitle, taskFile, scene } = {}) {
  const working = Boolean(busy || otherWork);
  const state = getWorkshopLife({ busy: working });
  if (command === 'clock') {
    const now = new Date();
    return `按这台设备的当地时间，现在是${now.getMonth() + 1}月${now.getDate()}日，星期${'日一二三四五六'[now.getDay()]} ${localMinute(now)}。`;
  }
  if (command === 'status') {
    if (busy) return taskTitle ? `我还在处理任务，当前步骤是“${taskTitle}”${taskFile ? '（' + taskFile + '）' : ''}。` : '我正在处理当前任务。';
    if (otherWork) return '我正在后台处理另一段对话的任务。';
    if (scene?.liveRoomActivity && Number(scene.routineUntil) === state.nextAt) return `我在工作台，${scene.liveRoomActivity.replace(/^未央/u, '')}。`;
    const title = state.activity === 'sing' && (workshopHumTitle() || (!state.manual && suggestWorkshopTune()));
    return title ? `我在工作台，正在哼《${title}》。` : `我在工作台，${state.label}。`;
  }
  if (!dispatchWorkshopCommand(command, { busy: working }))
    return otherWork && !busy ? '我正在处理另一段对话的任务，忙完就能休息。' : '我还在处理当前任务，做完就能回房间休息。';
  if (command === 'sing') {
    const title = playWorkshopHum(state.activity === 'sing' && !state.manual ? suggestWorkshopTune() : undefined);
    return title ? `我在工作台，正在哼《${title}》。` : '我在工作台哼歌。这个设备暂时无法播放哼声。';
  } else if (!command.startsWith('lamp-')) stopWorkshopHum();
  const next = getWorkshopLife({ busy: working });
  if (command === 'lamp-on' || command === 'lamp-off') return next.lampOn ? '工作台的台灯已经打开了。' : '工作台的台灯已经关了。';
  if (command === 'lamp-auto') return '台灯已恢复跟随作息。';
  if (command === 'tv-off') return '工作台的电视关好了。';
  if (command === 'auto') return `我按当地时间恢复作息了，现在${next.label}。`;
  return `我在工作台，${next.label}。`;
}

// 普通发送时可以就地问当前进度。明确排队的消息仍排队；引导只作用于绑定的原任务。
export function shouldAnswerWorkshopCommand(command, { busy, mode, instantStatus }) {
  return !busy || mode !== 'queue' || ((command === 'status' || command === 'clock' || command === 'tv-off') && Boolean(instantStatus));
}

export function createWorkshopChat(app, reportSyncError) {
  const saves = new WeakMap();
  function pending(client, id) {
    return client && saves.get(client)?.get(id);
  }
  function rememberRemote(client, id, messages) {
    let sessions = saves.get(client);
    if (!sessions) saves.set(client, (sessions = new Map()));
    const saved = Promise.resolve(sessions.get(id))
      .then(() => client.appendSession(id, messages))
      .catch((error) => reportSyncError(error))
      .finally(() => {
        if (sessions.get(id) === saved) sessions.delete(id);
      });
    sessions.set(id, saved);
    return saved;
  }
  async function reply(command, text, { echo, busy, byVoice, snapshot, mediaReply, submittedAt }) {
    const session = app.session;
    const client = app.server;
    const step = snapshot?.active && snapshot.entries.findLast((entry) => entry.status === 'running' || entry.status === 'waiting');
    const scene =
      command === 'status' &&
      globalThis.document?.querySelector?.('.work-studio-view[data-visible="true"][data-mode="live"] .ws-scene[data-live-room-activity]')?.dataset;
    const words =
      mediaReply ||
      answerWorkshopCommand(command, { busy, otherWork: snapshot?.otherWork, taskTitle: step?.title || app.active?.status, taskFile: step?.file, scene });
    const from = session.messages.length;
    if (busy) {
      if (echo) app.transcript.add('user', text, submittedAt);
    } else {
      app.speaker.cancel();
      app.takeTurnInput(text, echo, [], submittedAt);
    }
    const bubble = app.transcript.add('agent', words);
    bubble.done();
    // 服务器运行中禁止追加会话；和原来的“进度如何”一样即问即答，不给正在执行的任务添消息或步骤。
    if (busy) return true;
    app.liveBubble = bubble;
    app.rememberTurn('assistant', words, {}, session);
    app.dashboard.setTurns(session.messages.filter((message) => message.role === 'user').length);
    if (!app.active) app.setTask('idle');
    if ((byVoice || app.callActive || app.settings.readTyped) && command !== 'sing') app.speaker.speak(words);
    if (client) {
      const messages = session.messages.slice(from).map(({ role, content, ts }) => ({ role, content, ts }));
      await rememberRemote(client, session.id, messages);
    }
    return true;
  }
  return { reply, pending };
}
