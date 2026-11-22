import { sameTaskReceipt, verifiedTaskFiles } from '../app/nestTaskDelivery.js';
import { uid } from '../agent/store.js';
import { catalogGroups, loadCatalog } from './workspaceCatalog.js';
import { cityRoutes, defaultNestTrip, nestTripStops, readNestNotebook, saveNestNotebook, tripChecklist } from './nestNotebook.js';
import './nestDesk.css';

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function button(label, activate) {
  const item = node('button', label);
  item.type = 'button';
  item.onclick = activate;
  return item;
}

function field(caption, type, name, value) {
  const label = node('label', caption);
  const input = node('input');
  Object.assign(input, { type, name, value });
  label.append(input);
  return { label, input };
}

// 路线草图只表示停靠顺序；地理导航应使用实际地图。
function drawRoute(canvas, count) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#c1d8cd';
  ctx.lineWidth = 15;
  ctx.beginPath();
  ctx.moveTo(0, 54);
  ctx.bezierCurveTo(190, 92, 210, 2, 335, 36);
  ctx.bezierCurveTo(397, 49, 410, 94, 560, 44);
  ctx.stroke();
  const points = Array.from({ length: count }, (_, i) => [count === 1 ? 280 : 38 + 484 * i / (count - 1), [49, 23, 40, 51, 25][i]]);
  ctx.beginPath();
  points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#6b7652';
  ctx.setLineDash([8, 5]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.textAlign = 'center';
  ctx.font = 'bold 13px sans-serif';
  for (const [index, [x, y]] of points.entries()) {
    ctx.fillStyle = '#496145';
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = '#fffaf0';
    ctx.fillText(String(index + 1), x, y + 4);
  }
}

const tabs = { folder: '文件夹', draft: '草稿纸', trip: '旅行手账' };

export function createNestDesk({ scene, deskHost, perform, getWorkspace, getScope, getReceipt, useResult, openWorkspace, openFile }) {
  const panel = node('section', '', 'ws-nest-desk');
  panel.hidden = true;
  panel.dataset.nestDesk = '';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '书桌');
  const head = node('header');
  const heading = node('h3', '书桌');
  const back = button('回到小窝', () => close());
  head.append(heading, back);
  const nav = node('nav');
  nav.setAttribute('aria-label', '书桌物件');
  const content = node('div', '', 'ws-nest-desk-content');
  const message = node('p', '', 'ws-nest-desk-message');
  message.setAttribute('role', 'status');
  panel.append(head, nav, content, message);
  deskHost.append(panel);

  let scope = '', tab = '', opener = null, version = 0, notebook, draftDirty = false;
  let folderReceipt;
  const scopeNow = () => getScope?.() || '';
  const current = token => tab && version === token && scope === scopeNow();

  function save(part, notify) {
    if (scope !== scopeNow()) return false;
    try {
      saveNestNotebook(scope, part, notebook[part]);
      if (part === 'draft') draftDirty = false;
      if (notify) message.textContent = part === 'trip' ? '行程已保存在本机。' : '草稿已保存在本机。';
      return true;
    } catch (error) {
      message.textContent = '保存失败：' + error.message;
      return false;
    }
  }

  function close(restoreFocus = true) {
    if (!tab) return false;
    if (draftDirty && scope === scopeNow()) save('draft', false);
    version++;
    tab = '';
    panel.hidden = true;
    delete deskHost.dataset.deskOpen;
    content.replaceChildren();
    notebook = null;
    draftDirty = false;
    if (restoreFocus && opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
    scene.dispatchEvent(new Event('workshop:nest-panel-closed', { bubbles: true }));
    return true;
  }

  async function showFiles(token) {
    folderReceipt = getReceipt?.();
    const receipt = folderReceipt;
    const space = button('打开文件空间', () => { close(false); openWorkspace?.(); });
    const list = node('div', '', 'ws-nest-files');
    const info = node('small', '正在读取文件…');
    content.append(info, list, space);
    try {
      const source = getWorkspace();
      await source.restoreFolder();
      if (!tab || token !== version) return;
      if (scope !== scopeNow()) { open('folder', opener); return; }
      const [files, items] = await Promise.all([source.list(), loadCatalog(scope)]);
      if (!current(token)) return;
      if (!sameTaskReceipt(receipt, getReceipt?.())) { select('folder'); return; }
      const results = verifiedTaskFiles(receipt, files).filter(f => !items[f.path]?.trash);
      if (results.length) {
        const group = node('section', '', 'ws-nest-files');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', '本次任务成品');
        group.append(node('strong', '本次任务成品'));
        for (const file of results) {
          const name = file.path.split('/').pop();
          const row = node('div', '', 'ws-nest-result');
          const use = async edit => {
            if (!current(token)) return;
            try {
              await useResult(receipt, file, edit ? modify : preview, edit);
              if (edit && current(token)) close(false);
            } catch (error) { if (current(token)) message.textContent = error.message; }
          };
          const preview = button(name, () => use(false));
          preview.className = 'ws-nest-file';
          preview.dataset.path = file.path;
          preview.title = file.path;
          const modify = button('继续修改', () => use(true));
          modify.className = 'nest-edit';
          modify.setAttribute('aria-label', '继续修改 ' + name);
          row.append(preview, modify);
          group.append(row);
        }
        content.prepend(group);
      }
      const resultPaths = new Set(results.map(f => f.path));
      const recent = catalogGroups(files.filter(f => !resultPaths.has(f.path)), { items }).slice(0, 5);
      info.textContent = source.locationLabel + (recent.length ? ' · 最近文件' : results.length ? '' : ' · 暂无文件');
      for (const group of recent) {
        const path = group.files[0].path;
        const row = button(path.split('/').pop(), () => {
          if (!current(token)) return;
          try { source.check(); } catch (error) { message.textContent = error.message; return; }
          close(false);
          openFile(path);
        });
        row.className = 'ws-nest-file';
        row.dataset.path = path;
        row.title = path;
        list.append(row);
      }
    } catch (error) {
      if (current(token)) info.textContent = '未能读取文件：' + error.message;
    }
  }

  function showDraft() {
    const note = node('textarea');
    note.setAttribute('aria-label', '草稿纸');
    note.placeholder = '记下想法……';
    note.maxLength = 12000;
    note.value = notebook.draft;
    note.oninput = () => { notebook.draft = note.value; draftDirty = true; message.textContent = ''; };
    const store = button('保存草稿', () => save('draft', true));
    const copy = button('另存到工作区', async () => {
      const token = version;
      if (!current(token)) return;
      if (!note.value.trim()) { message.textContent = '请先写下草稿。'; note.focus(); return; }
      copy.disabled = true;
      try {
        const source = getWorkspace();
        await source.restoreFolder();
        if (!current(token)) return;
        const path = '草稿/书桌草稿-' + uid() + '.txt';
        const saved = await source.write(path, new Blob([note.value], { type: 'text/plain;charset=utf-8' }));
        if (current(token)) message.textContent = '已保存到' + source.locationLabel + '：' + (saved?.path || path);
      } catch (error) {
        if (current(token)) message.textContent = '另存失败：' + error.message;
      } finally { copy.disabled = false; }
    });
    content.append(note, store, copy);
  }

  function showTrip() {
    const trip = notebook.trip;
    const fields = node('div', '', 'ws-nest-trip-fields');
    const city = field('目的地', 'text', 'destination', trip.destination);
    city.input.maxLength = 50;
    const date = field('计划日期', 'date', 'tripDate', trip.date);
    fields.append(city.label, date.label);
    const places = node('div', '', 'ws-nest-trip-places');
    const stops = field('沿途想去的地方', 'text', 'stops', trip.stops);
    stops.input.maxLength = 160;
    stops.input.placeholder = '多个地点用顿号分开';
    const routeTitle = node('small', '路线草图');
    const sketch = node('canvas', '', 'ws-nest-trip-map');
    sketch.setAttribute('aria-hidden', 'true');
    sketch.width = 560;
    sketch.height = 76;
    const route = node('ol', '', 'ws-nest-trip-route');
    route.setAttribute('aria-label', '路线草图');
    const paint = () => {
      const placesOnRoute = nestTripStops({ destination: city.input.value.trim(), stops: stops.input.value });
      route.replaceChildren(...placesOnRoute.map(stop => node('li', stop)));
      drawRoute(sketch, placesOnRoute.length);
    };
    for (const destination of cityRoutes.keys()) places.append(button(destination, () => {
      city.input.value = destination;
      stops.input.value = '';
      paint();
    }));
    city.input.oninput = stops.input.oninput = paint;
    const items = node('div', '', 'ws-nest-trip-checks');
    const checks = tripChecklist.map((caption, index) => {
      const entry = field('', 'checkbox', 'item-' + index, 'on');
      entry.input.checked = trip.checked[index];
      entry.input.dataset.tripItem = index;
      entry.label.append(caption);
      items.append(entry.label);
      return entry.input;
    });
    const store = button('保存行程', () => {
      notebook.trip = { destination: city.input.value.trim(), date: date.input.value, stops: stops.input.value, checked: checks.map(item => item.checked) };
      save('trip', true);
    });
    content.append(fields, places, stops.label, routeTitle, sketch, route, items, store);
    paint();
  }

  function select(kind) {
    if (!Object.hasOwn(tabs, kind)) return;
    if (draftDirty && tab === 'draft' && kind !== 'draft') save('draft', false);
    const token = ++version;
    tab = kind;
    content.replaceChildren();
    message.textContent = '';
    heading.textContent = kind === 'trip' ? tabs.trip : '书桌';
    for (const item of nav.children) item.setAttribute('aria-pressed', String(item.dataset.deskTab === kind));
    perform?.(kind === 'trip' ? 'trip' : 'draft');
    if (kind === 'folder') void showFiles(token);
    else if (kind === 'draft') showDraft();
    else showTrip();
    content.scrollTop = 0;
  }

  for (const [kind, caption] of Object.entries(tabs)) {
    const item = button(caption, () => { if (scope === scopeNow() && kind !== tab) select(kind); });
    item.dataset.deskTab = kind;
    nav.append(item);
  }
  function open(kind, trigger) {
    if (!Object.hasOwn(tabs, kind)) return false;
    if (!tab || scope !== scopeNow()) {
      scope = scopeNow();
      draftDirty = false;
      try { notebook = readNestNotebook(scope); } catch { notebook = { draft: '', trip: defaultNestTrip() }; }
    }
    opener = trigger || opener;
    deskHost.dataset.deskOpen = 'true';
    panel.hidden = false;
    select(kind);
    back.focus({ preventScroll: true });
    return true;
  }
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });
  return { open, close, isOpen: () => Boolean(tab), render() {
    if (tab && scope !== scopeNow()) close(false);
    else if (tab === 'folder' && !sameTaskReceipt(folderReceipt, getReceipt?.())) select('folder');
  }, setVisible(on) { if (!on) close(false); } };
}
