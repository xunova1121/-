import { createStudioLibrary } from '../agent/studioLibrary.js';
import * as ws from '../agent/workspace.js';
import { userStorageSuffix } from '../core/userStorage.js';
import { revisionRequest, brandInstruction } from '../core/studioData.js';
import { configurationReadiness } from '../../shared/capabilityReadiness.js';
import { WORKFLOW_PRESETS } from '../agent/workflowPresets.js';
import * as registry from '../agent/agentProfiles.js';
import * as sessions from '../agent/sessions.js';

/** 每次打开捕获运行端/身份；请求完成后核对，禁止填入新账号、新服务器或新草稿。 */
export function createStudioActions(app, { fill, start }) {
  function capture() {
    const server = app.server,
      identity = userStorageSuffix(),
      mode = ws.mode(),
      folder = ws.folderName();
    const check = () => {
      if (server !== app.server || identity !== userStorageSuffix() || mode !== ws.mode() || folder !== ws.folderName())
        throw new Error('账号、服务器或工作区已切换，请重新打开');
    };
    const files = {
      ...ws,
      readBlob: async (path) => {
        check();
        const blob = await ws.readBlob(path);
        check();
        return blob;
      },
      write: async (...args) => {
        check();
        return ws.write(...args);
      }
    };
    const client = server ? server.studio : createStudioLibrary({ files });
    if (!client) throw new Error('服务器版本较旧，请先更新服务器');
    const call = async (method, ...args) => {
      check();
      const value = await client[method](...args);
      check();
      return value;
    };
    return {
      server,
      check,
      call,
      async preview(path, signal) {
        check();
        const format = ws.ext(path);
        // 只在内存预览，绝不以云端同名文件覆盖本机工作区。
        const office = ['docx', 'pptx', 'xlsx'].includes(format);
        const blob = server && office ? await client.preview(path, signal) : server ? await server.download(path) : await files.readBlob(path);
        check();
        return { blob, format: server && office ? 'pdf' : format, rendered: Boolean(server && office) };
      },
      async uploadPicture(file) {
        check();
        if (!file || file.size > 10e6 || !/\.(png|jpe?g)$/i.test(file.name)) throw new Error('请选择10MB以内PNG或JPEG图片');
        const path = `编辑素材/${crypto.randomUUID()}.${ws.ext(file.name)}`;
        if (server) await server.upload(path, file);
        else await files.write(path, file);
        check();
        return path;
      },
      async download(path) {
        check();
        const blob = server ? await server.download(path) : await ws.readBlob(path);
        check();
        return blob;
      },
      async editPrompt(path, selection, instruction, withBrand) {
        const session = app.session,
          draft = document.querySelector('#prompt')?.value || '';
        const prefs = withBrand ? await call('preferences') : null;
        check();
        if (session !== app.session || draft !== (document.querySelector('#prompt')?.value || '')) throw new Error('对话或草稿已变化，请重新选择作品');
        if (draft.trim()) throw new Error('输入框已有草稿，请先发送或保存草稿，再继续修改作品');
        const text = revisionRequest({ path, selection, instruction, brand: prefs?.brand });
        const next = sessions.create();
        await app.switchTo(next);
        check();
        if (app.session !== next || (document.querySelector('#prompt')?.value || '').trim()) throw new Error('对话或草稿已变化，未覆盖输入');
        fill(text);
        app.closeSide?.();
      },
      async useTemplate(path) {
        const session = app.session,
          draft = document.querySelector('#prompt')?.value || '';
        const prefs = await call('preferences');
        const result = await call('copy', { path, title: '模板创作' });
        if (session !== app.session || draft !== (document.querySelector('#prompt')?.value || ''))
          throw new Error('草稿已变化，模板副本已保存在作品中，未覆盖输入');
        const next = sessions.create();
        await app.switchTo(next);
        check();
        if (app.session !== next || (document.querySelector('#prompt')?.value || '') !== draft) throw new Error('对话或草稿已变化，模板副本保留在作品中');
        fill(`请基于工作区文件“${result.path}”创作，先读取原件，保留可编辑文字、图形和版式；版式偏好：${brandInstruction(prefs.brand)}。\n我的要求：${draft}`);
      }
    };
  }
  return {
    capture,
    async configuration() {
      const token = capture();
      if (token.server) return null;
      const cfg = await app.modelWorkspace?.config('local');
      token.check();
      // 云端不凭脱敏Key判断缺失；完整能力检查由用户主动触发。
      return token.server ? null : { checks: configurationReadiness(cfg, { gatewayKeys: app.gateway?.keys || [] }) };
    },
    async workflow(id) {
      const token = capture();
      const preset = WORKFLOW_PRESETS.find((x) => x.id === id);
      if (!preset) throw new Error('找不到工作流');
      const profiles = token.server?.agentProfiles || registry.createAgentRegistry();
      let key = 'studio-' + id;
      let profile = await profiles.getAgent(key);
      token.check();
      if (profile && JSON.stringify(profile.steps) !== JSON.stringify(preset.steps)) {
        // 用户改过的工作流保留；快捷入口不暗中沿用或覆盖另一份步骤。
        key += '-' + crypto.randomUUID().slice(0, 8);
        profile = null;
      }
      if (!profile) {
        const base = registry.BUILTIN_AGENTS.find((x) => x.id === (id === 'research-ppt' ? 'ppt-maker' : 'gongwen-writer'));
        profile = await profiles.createAgent({
          ...base,
          id: key,
          name: preset.name,
          intro: '按步骤完成，保留中间成果；复杂制作先确认提纲。',
          source: 'user',
          steps: preset.steps
        });
        token.check();
      }
      await start(profile);
    }
  };
}
