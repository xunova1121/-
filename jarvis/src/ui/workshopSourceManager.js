import {
  listWorkshopChannels, removedWorkshopChannels, setWorkshopBuiltinVisible,
  normalizeWorkshopSource, removeWorkshopSource, saveWorkshopSource
} from './workshopMediaChannels.js';
import { mediaNode } from './workshopMediaView.js';
import './workshopSourceManager.css';

function control(text, click, className = '') {
  const button = mediaNode('button', className, text);
  button.type = 'button';
  button.onclick = click;
  return button;
}

function field(label, input) {
  const wrapper = mediaNode('label', 'ws-source-field');
  wrapper.append(mediaNode('span', '', label), input);
  return wrapper;
}

export function createWorkshopSourceManager(ui, { preview, restoreChannel, selectChannel, updateChannelState }) {
  const panel = mediaNode('section', 'ws-source-manager');
  const header = mediaNode('div', 'ws-source-head');
  const heading = mediaNode('h4', '');
  const closeButton = control('关闭', () => dismiss(true));
  closeButton.setAttribute('aria-label', '关闭视频源管理');
  header.append(heading, closeButton);
  const body = mediaNode('div', 'ws-source-body');
  const list = mediaNode('div', 'ws-source-list');
  const listError = mediaNode('p', 'ws-source-error');
  listError.setAttribute('role', 'alert');
  const form = mediaNode('form', 'ws-source-form');
  const name = mediaNode('input', '');
  name.maxLength = 80;
  name.placeholder = '例如 城市新闻';
  name.autocomplete = 'off';
  const url = mediaNode('input', '');
  url.type = 'url';
  url.placeholder = 'http(s)://…/直播.m3u8';
  url.autocomplete = 'off';
  url.spellcheck = false;
  const format = mediaNode('select', '');
  for (const [value, label] of [['auto', '自动识别'], ['hls', 'HLS（M3U8）'], ['video', '直接视频（如 MP4）']]) {
    const option = mediaNode('option', '', label);
    option.value = value;
    format.append(option);
  }
  const note = mediaNode('small', 'ws-source-note', '保存到此设备。支持 HTTP / HTTPS 的 M3U8 和视频直链。');
  const error = mediaNode('p', 'ws-source-error');
  error.setAttribute('role', 'alert');
  const actions = mediaNode('div', 'ws-source-actions');
  const save = mediaNode('button', 'ws-source-save', '保存并播放');
  save.type = 'submit';
  const trial = control('试播', () => readDraft(draft => {
    const source = normalizeWorkshopSource(draft);
    testing = true;
    display('preview');
    preview(source);
    focusControl();
  }));
  const remove = control('移除', () => {
    remove.hidden = true;
    confirmRemove.hidden = false;
    cancelRemove.hidden = false;
    cancelRemove.focus();
  }, 'ws-source-remove');
  const confirmRemove = control('确认移除', () => readDraft(() => {
    removeWorkshopSource(editingId);
    openList();
  }), 'ws-source-remove');
  const cancelRemove = control('保留', () => {
    confirmRemove.hidden = cancelRemove.hidden = true;
    remove.hidden = false;
    remove.focus();
  });
  const returnToList = control('我的视频源', openList);
  actions.append(save, trial, remove, confirmRemove, cancelRemove, returnToList);
  form.noValidate = true;
  form.append(field('频道名称', name), field('播放地址', url), field('播放格式', format), note, error, actions);
  body.append(list, form);
  panel.append(header, body);
  ui.television.append(panel);

  function focusControl() {
    const control = ui.tune.hidden || !ui.stations.hidden ? ui.manageSources : ui.tune;
    control.focus({ preventScroll: true });
  }
  let mode = 'closed';
  let editingId = '';
  let testing = false;
  function display(next) {
    mode = next;
    const visible = mode === 'list' || mode === 'edit';
    ui.manageSources.textContent = mode === 'preview' ? '返回编辑' : '视频源';
    ui.manageSources.setAttribute('aria-label', mode === 'preview' ? '返回编辑视频源' : '管理视频源');
    ui.manageSources.setAttribute('aria-expanded', String(visible));
    panel.hidden = !visible;
    list.hidden = mode !== 'list';
    form.hidden = mode !== 'edit';
    panel.setAttribute('aria-label', mode === 'list' ? '我的视频源' : editingId ? '编辑视频源' : '添加视频源');
    heading.textContent = panel.getAttribute('aria-label');
    body.scrollTop = 0;
    updateChannelState();
  }
  function stopTrial() {
    if (!testing) return;
    testing = false;
    restoreChannel();
  }
  function reset() {
    testing = false;
    editingId = '';
    name.value = url.value = error.textContent = '';
    format.value = 'auto';
    list.replaceChildren();
    display('closed');
  }
  function dismiss(focus) {
    stopTrial();
    reset();
    if (focus) focusControl();
  }
  function edit(source) {
    editingId = source?.id || '';
    name.value = source?.title || '';
    url.value = source?.source.url || '';
    format.value = source?.source.format || 'auto';
    error.textContent = '';
    remove.hidden = !editingId;
    confirmRemove.hidden = cancelRemove.hidden = true;
    display('edit');
    closeButton.focus({ preventScroll: true });
  }
  function renderList() {
    const add = control('添加视频源', () => edit(null), 'ws-source-save');
    list.replaceChildren(add);
    function toggle(source, restore) {
      const label = restore ? '恢复' : '移除';
      const action = control(label, () => {
        const siblings = [...list.querySelectorAll('[data-toggle]')];
        const index = siblings.indexOf(action);
        try {
          listError.textContent = '';
          setWorkshopBuiltinVisible(source.id, restore);
          const buttons = list.querySelectorAll('[data-toggle]');
          (buttons[index] || buttons[buttons.length - 1] || add).focus({ preventScroll: true });
        } catch (cause) { listError.textContent = cause.message; listError.scrollIntoView({ block: 'nearest' }); }
      }, restore ? '' : 'ws-source-remove');
      action.dataset.toggle = source.id;
      action.setAttribute('aria-label', label + ' ' + source.label);
      return action;
    }
    const channels = listWorkshopChannels();
    const custom = channels.filter(source => source.kind === 'custom');
    const defaults = channels.filter(source => source.kind !== 'custom');
    for (const source of [...custom, ...defaults]) {
      if (source === defaults[0]) list.append(mediaNode('h5', 'ws-source-group', '默认频道'));
      const row = mediaNode('div', 'ws-source-row');
      const tune = control(source.label, () => { reset(); selectChannel(source.id); focusControl(); });
      tune.setAttribute('aria-label', '播放 ' + source.label);
      if (source.kind === 'custom') {
        const editButton = control('编辑', () => edit(source));
        editButton.setAttribute('aria-label', '编辑 ' + source.label);
        row.append(tune, editButton);
      } else row.append(tune, toggle(source, false));
      list.append(row);
    }
    const removed = removedWorkshopChannels();
    if (removed.length) {
      list.append(mediaNode('h5', 'ws-source-group', '已移除的默认频道'));
      for (const source of removed) {
        const row = mediaNode('div', 'ws-source-row');
        row.append(mediaNode('span', '', source.label), toggle(source, true));
        list.append(row);
      }
    }
    list.append(listError);
  }
  function openList() {
    stopTrial();
    editingId = '';
    listError.textContent = '';
    renderList();
    display('list');
    list.firstElementChild.focus({ preventScroll: true });
  }
  function readDraft(act) {
    error.textContent = '';
    try {
      act({ id: editingId || undefined, name: name.value, url: url.value, format: format.value });
    } catch (cause) {
      error.textContent = cause.message || '操作失败，请重试。';
      body.scrollTop += Math.max(0, error.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom);
    }
  }
  form.onsubmit = event => {
    event.preventDefault();
    readDraft(draft => {
      const source = saveWorkshopSource(draft);
      reset();
      selectChannel(source.id);
      focusControl();
    });
  };
  ui.manageSources.onclick = () => {
    if (mode === 'preview') {
      display('edit');
      save.focus({ preventScroll: true });
    } else if (!panel.hidden) dismiss(true);
    else openList();
  };
  panel.hidden = true;
  return {
    reset,
    testing: () => testing,
    suspend() {
      testing = false;
      if (mode === 'preview') display('edit');
    },
    refresh() { if (mode === 'list') renderList(); },
    escape() {
      if (mode === 'closed') return false;
      dismiss(true);
      return true;
    }
  };
}
