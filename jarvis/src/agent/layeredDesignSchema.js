/** 仅制图任务加载的分层设计协议；旧海报/大屏字段继续可用。 */
const str = { type: 'string' }, num = { type: 'number' };
const point = { type: 'object', properties: { label: str, value: num }, required: ['label', 'value'], additionalProperties: false };
const layerFields = {
  id: str, type: { type: 'string', enum: ['text', 'shape', 'icon', 'image', 'chart'] },
  x: num, y: num, w: num, h: num, text: str, fontSize: num, minFontSize: num,
  weight: { type: 'integer', enum: [400, 700] }, color: str, fill: str, stroke: str,
  radius: num, align: { type: 'string', enum: ['left', 'center', 'right'] },
  icon: { type: 'string', description: '自带矢量图标：news/chart/leaf/heart/star/calendar/cloud/check/arrow/building' },
  asset: str, fit: { type: 'string', enum: ['cover', 'contain'] },
  role: { type: 'string', enum: ['heading', 'body', 'label', 'caption'], description: '文字用途；正文不能标成caption来逃避手机可读字号检查' },
  points: { type: 'array', maxItems: 24, items: point },
  chartType: { type: 'string', enum: ['line', 'bar'], description: '分类/不同指数涨跌幅对比用bar；line仅用于真实有序趋势，不能把三个指数连成走势' },
  unit: str,
  detail: str, group: str, category: str, decorative: { type: 'boolean' }
};
export const LAYERED_PROPERTIES = {
  dataMode: { type: 'string', enum: ['demo', 'provided'], description: '默认明确演示；provided需source，仅说明用户提供，不证明已联网核实' },
  source: { type: 'string', description: '文案/数据来源；原样保留，不虚构事实' },
  asOf: { type: 'string', description: '文案/数据对应时间；不冒充当前实测' },
  font_family: { type: 'string', enum: ['sans', 'serif'], description: '统一真实字体：sans黑体、serif宋体；导出逐字检查实际字形' },
  design: {
    type: 'object', additionalProperties: false,
    description: '新稿优先使用。按内容构图；layout只是起稿，layers可完全自由排版。source_path+design可重新构图/换画幅，默认复用原栏目和素材；改字用changes。精确文字独立排字，图片用工作区无字素材。',
    properties: {
      eyebrow: { type: 'string', description: '可选栏目/品牌眉题' },
      layout: { type: 'string', enum: ['editorial', 'campaign', 'timeline', 'newspaper', 'celebration', 'dashboard', 'free'], description: '真正不同的结构：editorial主次编排；campaign图文融合宣传；timeline时间轴；newspaper报纸分栏；free用layers逐个指定坐标，支持自由构图，无需手改SVG。只换palette不是换版式。' },
      reading: { type: 'string', enum: ['phone', 'desktop'], description: '阅读场景；竖版默认phone，按390px整图宽度检查正文至少12px；横版默认desktop。不靠4K像素掩盖小字。' },
      palette: { type: 'object', properties: { background: str, ink: str, muted: str, accent: str, card: str }, additionalProperties: false },
      assets: { type: 'array', maxItems: 4, items: { type: 'object', properties: { id: str, path: str }, required: ['id', 'path'], additionalProperties: false } },
      sections: { type: 'array', maxItems: 12, items: { type: 'object', properties: {
        title: str, body: str, eyebrow: str, icon: layerFields.icon, value: str, unit: str, detail: str, category: str,
        points: layerFields.points, chartType: layerFields.chartType
      }, required: ['title'], additionalProperties: false } },
      layers: { type: 'array', maxItems: 160, description: '自由构图的完整独立图层，顺序为从底到顶；坐标单位为画布像素。例如1080×1920画布的文字层：{id:"title",type:"text",x:64,y:80,w:900,h:140,text:"今日要闻",fontSize:80,role:"heading"}。图片先在assets登记，再用image层的asset引用ID。', items: { type: 'object', properties: layerFields, required: ['id', 'type', 'x', 'y', 'w', 'h'], additionalProperties: false } },
      states: { type: 'array', maxItems: 4, description: '真实可切换的数据快照；只有明确提供的值才更新，不制造实时数据。', items: {
        type: 'object', properties: { label: str, changes: { type: 'array', maxItems: 40, items: { type: 'object', properties: { id: str, text: str, points: layerFields.points }, required: ['id'], additionalProperties: false } } }, required: ['label', 'changes'], additionalProperties: false
      } }
    }
  },
  changes: { type: 'array', maxItems: 80, description: 'source_path指向.design.json时按id改字、坐标或样式；原稿和图片不变，所有格式同步另存。', items: { type: 'object', properties: layerFields, required: ['id'], additionalProperties: false } }
};

export const usesLayeredDesign = input => Boolean(input?.design || /\.design\.json$/i.test(input?.source_path || ''));
