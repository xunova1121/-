import { studioNode as el, studioButton as button } from './studioHub.js';
import { cleanBrand, studioFileTitle } from '../core/studioData.js';
import { saveFile } from './saveFile.js';
import { createStudioPreview } from './studioPreview.js';

const label = (text, input) => el('label', { className: 'wy-library-field' }, el('span', { textContent: text }), input);
const input = (hint, value = '') => el('input', { placeholder: hint, value, maxLength: 300, ariaLabel: hint });
const titles = { works: '我的作品', templates: '我的模板', team: '团队共享', brand: '品牌样式' };
/** 所有异步界面受打开代次和账号范围保护，关闭后不会复活旧页面。 */
export function createStudioPanel({ actions, toast }) {
  let generation = 0,
    token = null,
    tab = 'works';
  let preview = null;
  const clearPreview = () => {
    preview?.close();
    preview = null;
  };
  const heading = el('h2');
  const body = el('div', { className: 'wy-library-body' });
  const root = el('dialog', { className: 'wy-library', ariaLabel: '我的创作' }, el('header', {}, heading, button('关闭', close)), body);
  document.body.append(root);
  root.addEventListener('close', () => {
    clearPreview();
    generation++;
    token = null;
  });
  const current = (stamp, captured) => stamp === generation && root.open && captured === token;
  async function run(fn) {
    const captured = token;
    try {
      await fn();
    } catch (error) {
      if (root.open && token === captured) toast(error.message);
    }
  }
  function action(text, fn, className) {
    return button(text, () => run(fn), className);
  }
  function close() {
    clearPreview();
    generation++;
    root.close();
    token = null;
  }
  function guard() {
    if (!token || !root.open) throw new Error('页面已关闭，请重新打开');
    token.check();
  }
  async function open(next = 'works') {
    clearPreview();
    generation++;
    tab = next;
    token = actions.capture();
    heading.textContent = titles[tab];
    body.replaceChildren(el('p', { textContent: '正在读取…', role: 'status' }));
    if (!root.open) root.showModal();
    await run(render);
  }
  async function render() {
    guard();
    const stamp = ++generation,
      captured = token;
    if (tab === 'brand') return brand(stamp, captured);
    const data =
      tab === 'team'
        ? token.server
          ? await token.call('team')
          : []
        : tab === 'templates'
          ? (await token.call('preferences')).templates
          : await token.call('list');
    if (!current(stamp, captured)) return;
    const query = input('搜索作品或模板');
    const rows = el('div', { className: 'wy-library-rows' });
    const tabs = el(
      'nav',
      { className: 'wy-library-tabs', ariaLabel: '作品分类' },
      ...Object.entries(titles).map(([key, title]) => action(title, () => open(key)))
    );
    const draw = () => {
      const visible = data.filter((row) =>
        String(row.title || row.path || '')
          .toLowerCase()
          .includes(query.value.trim().toLowerCase())
      );
      rows.replaceChildren(
        ...visible.map((row) => {
          const line = el('article', { className: 'wy-library-row' }, el('strong', { textContent: row.title || studioFileTitle(row.path) }));
          if (tab === 'team') {
            line.append(
              el('small', {
                textContent: `${row.kind === 'template' ? '模板' : '作品'} · ${row.mine ? '我发布的' : '可查看和复制'} · ${(row.size / 1024).toFixed(0)} KB`
              }),
              action('复制到我的作品', async () => {
                guard();
                const copied = await captured.call('importShared', row.id);
                if (!current(stamp, captured)) return;
                toast('副本已保存：' + copied.path);
                await open('works');
              })
            );
            if (row.mine)
              line.append(
                action('撤回共享', () =>
                  confirm('撤回后其他成员不能再获取此共享；已经复制的文件会保留。', async () => {
                    await captured.call('unshare', row.id);
                    await open('team');
                  })
                )
              );
          } else {
            line.append(
              el('small', { textContent: row.path }),
              action('打开与修改', () => details(row.path))
            );
            if (tab === 'templates') {
              line.append(
                action('用此模板', async () => {
                  await captured.useTemplate(row.path);
                  if (current(stamp, captured)) close();
                }),
                action('移出模板库', async () => {
                  await captured.call('change', { action: 'remove-template', path: row.path });
                  if (current(stamp, captured)) await render();
                })
              );
            }
          }
          return line;
        })
      );
      if (!visible.length)
        rows.append(
          el('p', {
            className: 'wy-library-empty',
            textContent: query.value
              ? '没有匹配的作品。'
              : tab === 'team'
                ? token.server
                  ? '尚无共享。打开自己的作品，选择“发布到团队”。'
                  : '团队共享需要连接云服务器，个人作品仍可正常使用。'
                : tab === 'templates'
                  ? '打开一份作品，选择“存为我的模板”。'
                  : '上传资料或完成一次创作后，作品会出现在这里。'
          })
        );
    };
    query.oninput = draw;
    body.replaceChildren(tabs, query, rows);
    draw();
  }
  function confirm(message, fn) {
    const box = el('section', { className: 'wy-library-confirm' }, el('p', { textContent: message }));
    const yes = action('确认', async () => {
      yes.disabled = true;
      try {
        guard();
        await fn();
        box.remove();
      } finally {
        yes.disabled = false;
      }
    });
    box.append(
      yes,
      button('取消', () => box.remove())
    );
    body.append(box);
    box.scrollIntoView({ block: 'nearest' });
  }
  async function brand(stamp, captured) {
    const state = await captured.call('preferences');
    if (!current(stamp, captured)) return;
    const fields = Object.fromEntries(
      [
        ['name', '单位或品牌'],
        ['color', '主色（#315EEF）'],
        ['font', '字体名称'],
        ['footer', '页脚文字'],
        ['logo', '工作区中的标识文件路径']
      ].map(([key, text]) => [key, { text, node: input(text, state.brand[key]) }])
    );
    body.replaceChildren(
      el('p', { textContent: '保存常用版式，使用个人模板或自然语言修改时可带入。这里保存样式偏好，不会自动修改现有作品。' }),
      ...Object.values(fields).map((f) => label(f.text, f.node)),
      action('保存品牌样式', async () => {
        const value = Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, f.node.value]));
        if (!/^#[a-f0-9]{6}$/i.test(value.color)) throw new Error('主色请填写六位颜色，例如 #315EEF');
        await captured.call('change', { action: 'brand', brand: cleanBrand(value) });
        if (current(stamp, captured)) toast('品牌样式已保存');
      })
    );
  }
  async function details(path) {
    clearPreview();
    guard();
    const stamp = ++generation,
      captured = token;
    heading.textContent = studioFileTitle(path);
    body.replaceChildren(el('p', { textContent: '正在读取文件结构…', role: 'status' }));
    const [inspection, versions] = await Promise.all([captured.call('inspect', path), captured.call('versions', path)]);
    if (!current(stamp, captured)) return;
    const toolbar = el(
      'div',
      { className: 'wy-library-tools' },
      action('返回列表', () => open(tab)),
      action('预览', async () => {
        clearPreview();
        const host = el('section', { className: 'wy-studio-preview', ariaLabel: '作品预览' }, el('p', { textContent: '正在渲染…' }));
        body.prepend(host);
        const viewer = createStudioPreview(host);
        preview = viewer;
        try {
          const data = await captured.preview(path, viewer.signal);
          if (current(stamp, captured) && preview === viewer) await viewer.show(data);
        } catch (error) {
          if (!viewer.signal.aborted) {
            host.replaceChildren(el('p', { textContent: error.message }));
            throw error;
          }
        }
      }),
      action('下载', async () => {
        const blob = await captured.download(path);
        if (current(stamp, captured)) await saveFile(blob, path.split('/').pop());
      }),
      action('复制为新作品', async () => {
        const saved = await captured.call('copy', { path });
        if (current(stamp, captured)) await details(saved.path);
      }),
      action('存为我的模板', async () => {
        await captured.call('copy', { path, template: true });
        if (current(stamp, captured)) toast('已保存独立模板副本');
      })
    );
    if (captured.server)
      toolbar.append(
        action('发布到团队', () =>
          confirm('仅发布这一个文件的副本。本服务器所有已登录成员均可查看、复制；不会共享对话和私人目录。', async () => {
            await captured.call('share', { path, title: path.split('/').pop(), kind: tab === 'templates' ? 'template' : 'work', confirm: true });
            toast('已发布到团队，可随时撤回');
          })
        )
      );
    body.replaceChildren(toolbar);
    const scope = input('修改范围，例如第3页、标题、第二段');
    const description = el('textarea', { placeholder: '例如：第3页改为左右分栏，文字不变', maxLength: 2000, ariaLabel: '修改要求' });
    const withBrand = el('input', { type: 'checkbox' });
    body.append(
      el('h3', { textContent: '告诉未央怎么改' }),
      scope,
      description,
      label('使用我的品牌样式', withBrand),
      action('带入对话继续修改', async () => {
        await captured.editPrompt(path, scope.value, description.value, withBrand.checked);
        if (current(stamp, captured)) close();
      }),
      el('p', { className: 'wy-library-note', textContent: '先填入草稿，由你发送后调用模型；按实际模型配置计费。' })
    );
    if (['docx', 'pptx', 'xlsx'].includes(inspection.format)) directEditor({ path, inspection, stamp, captured });
    const history = el('details', { className: 'wy-library-history' }, el('summary', { textContent: '版本与原件' }));
    for (const version of versions.slice(0, 30))
      history.append(
        el(
          'div',
          {},
          el('span', { textContent: (version.original ? '原件 · ' : '版本 · ') + studioFileTitle(version.path) }),
          action('打开', () => details(version.path)),
          action('恢复为新副本', () =>
            confirm('将此版本复制成新作品，当前文件和原件都会保留。', async () => {
              const saved = await captured.call('copy', { path: version.path });
              if (current(stamp, captured)) await details(saved.path);
            })
          )
        )
      );
    body.append(history);
  }
  function directEditor({ path, inspection, stamp, captured }) {
    const objects = inspection.objects.filter((x) => x.id || x.sheet);
    const select = el(
      'select',
      { ariaLabel: '选择页面或对象' },
      ...objects.map((o, i) =>
        el('option', {
          value: String(i),
          textContent:
            `${o.page ? '第' + o.page + '页 · ' : ''}${o.sheet || { sp: '文字', pic: '图片', graphicFrame: '图表或表格', grpSp: '组合' }[o.kind] || '段落'} ${i + 1} · ${o.text || o.range || ''}`.slice(
              0,
              180
            )
        })
      )
    );
    const before = input('原文字（须唯一匹配）'),
      after = input('替换为');
    const font = input('字体名称（可选）'),
      size = el('input', { type: 'number', min: '5', max: '120', placeholder: '字号', ariaLabel: '字号' });
    const alignment = el(
      'select',
      { ariaLabel: '对齐方式' },
      ...[
        ['', '不改对齐'],
        ['left', '左对齐'],
        ['center', '居中'],
        ['right', '右对齐']
      ].map(([value, textContent]) => el('option', { value, textContent }))
    );
    const update = () => {
      const object = objects[Number(select.value)];
      before.value = object?.truncated ? '' : object?.text || '';
    };
    select.onchange = update;
    update();
    const commit = async (value) => {
      const saved = await captured.call('edit', { path, sha256: inspection.sha256, ...value });
      if (!current(stamp, captured)) return;
      toast('已另存新版本，原件保留；请预览检查版式');
      await details(saved.path);
    };
    const box = el(
      'details',
      { className: 'wy-library-editor' },
      el('summary', { textContent: '直接调整文字与格式 · 不调用模型' }),
      el('p', { textContent: `显示前${objects.length}个对象，文件共${inspection.total}个。复杂修改可使用上方对话入口。` }),
      select
    );
    if (inspection.format !== 'xlsx')
      box.append(
        label('原文字', before),
        label('新文字', after),
        action('替换文字并另存', async () => {
          if (!before.value) throw new Error('请填写原文字');
          const object = objects[Number(select.value)];
          await commit({ replacements: [{ find: before.value, replace: after.value }], slides: object?.page ? [object.page] : [] });
        })
      );
    box.append(
      label('字体', font),
      label('字号', size),
      alignment,
      action('应用格式并另存', async () => {
        const object = objects[Number(select.value)];
        if (!object) throw new Error('请选择对象');
        const properties = {
          ...(font.value.trim() && { font_family: font.value.trim() }),
          ...(size.value && { font_size: Number(size.value) }),
          ...(alignment.value && { alignment: alignment.value })
        };
        if (!Object.keys(properties).length) throw new Error('请至少选择一项格式');
        await commit({
          operations: [{ action: 'format', target: object.sheet ? { sheet: object.sheet, range: object.range } : { id: object.id }, properties }]
        });
      })
    );
    if (inspection.format === 'pptx') {
      const picture = el('input', { type: 'file', accept: 'image/png,image/jpeg', ariaLabel: '替换图片' });
      box.append(
        label('替换所选图片', picture),
        action('换图并另存', async () => {
          const object = objects[Number(select.value)];
          if (object?.kind !== 'pic') throw new Error('请先选择一个图片对象');
          const source = await captured.uploadPicture(picture.files[0]);
          if (current(stamp, captured)) await commit({ picture: { target: object.id, path: source } });
        })
      );
      const dimensions = ['x', 'y', 'width', 'height'].map((key) => ({
        key,
        node: el('input', { type: 'number', step: '0.1', placeholder: key, ariaLabel: '位置尺寸 ' + key })
      }));
      box.append(
        el('p', { textContent: '移动或缩放所选对象（单位：英寸；留空不改）' }),
        ...dimensions.map(({ key, node }) => label(key, node)),
        action('调整位置尺寸并另存', async () => {
          const object = objects[Number(select.value)];
          if (!object) throw new Error('请选择对象');
          const properties = Object.fromEntries(dimensions.filter((x) => x.node.value !== '').map((x) => [x.key, Number(x.node.value)]));
          if (!Object.keys(properties).length) throw new Error('请填写位置或尺寸');
          await commit({ operations: [{ action: 'move_resize', target: { id: object.id }, properties }] });
        })
      );
    }
    body.append(box);
  }
  return { root, open, close };
}
