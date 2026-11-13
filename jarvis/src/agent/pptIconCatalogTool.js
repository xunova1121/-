import { PPT_ICON_CATALOG } from './pptIconCatalog.js';
export const pptIconCatalogTool = {
  name: 'get_ppt_icon_catalog',
  description: '按主题查询PPT图标名字与中文含义；在PPT每页正文写“图标：名字1, 名字2”，按内容选择，同页不重复。',
  input_schema: {type:'object',properties:{topic:{type:'string',description:'体育/餐饮/医疗/交通/教育/科技/商务/自然生活；空则列主题'}},additionalProperties:false},
  run: async ({topic = ''} = {}) => {
    const groups = [...new Set(Object.values(PPT_ICON_CATALOG).map(icon=>icon.topic))];
    if (!topic) return JSON.stringify({topics:groups,total:Object.keys(PPT_ICON_CATALOG).length});
    return JSON.stringify({icons:Object.entries(PPT_ICON_CATALOG).filter(([name,icon])=>[name,icon.label,icon.topic].some(value=>value.includes(String(topic).slice(0,40)))).slice(0,80).map(([name,icon])=>({name,...icon})),note:'按页选，不新增选图模型调用；正式PPT保持原风格'});
  }
};
