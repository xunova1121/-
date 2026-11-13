/** 智能体图标：设计稿 docs/design/agent-square-20261105/icons/agents 里的原创线性 SVG（currentColor，跟随主题色） */
export const AGENT_ICONS = {
  business: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V4h9v17M14 10h5v11M8 8h3M8 12h3M8 16h3M17 14v3"/></svg>',
  gongwen: "<svg aria-hidden=\"true\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.65\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h5\"/></svg>",
  health: "<svg aria-hidden=\"true\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.65\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 5c-3-3-7 0-8 2-1-2-5-5-8-2-4 4 1 9 8 15 7-6 12-11 8-15 M7 12h3l2-4 2 7 2-3h3\"/></svg>",
  market: "<svg aria-hidden=\"true\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.65\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 3v17h17 M7 15l4-5 4 2 5-7 M16 5h4v4\"/></svg>",
  ocr: "<svg aria-hidden=\"true\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.65\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 8V3h5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5 M7 8h10 M12 8v9 M9 17h6\"/></svg>",
  poster: "<svg aria-hidden=\"true\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.65\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 3h16v18H4z M7 6h10 M7 16l4-5 3 3 3-2 M7 18h10\"/></svg>",
  ppt: "<svg aria-hidden=\"true\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.65\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 4h16v12H4z M8 21l4-5 4 5 M8 9h3 M8 12h6 M16 8v4\"/></svg>",
  research: "<svg aria-hidden=\"true\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.65\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M14 4H5v16h14v-8 M9 8h3 M9 12h2 M18 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M21 10l2 2\"/></svg>",
  weather: "<svg aria-hidden=\"true\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.65\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M6 8a5 5 0 1 1 9 3 M5 3l1 1 M12 1v2 M19 4l-2 1 M3 10H1 M8 19h10a4 4 0 0 0 0-8 5 5 0 0 0-9 1 4 4 0 0 0-1 7\"/></svg>",
  // 自建智能体没选图标时用：一颗星
  spark: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.2 5.3L20 9l-4.4 3.8L17 19l-5-3-5 3 1.4-6.2L4 9l5.8-.7z"/></svg>'
};
/** 每个图标配一种底色（设计说明里的 green / blue / rose / gold 令牌），没有的用主色 */
export const AGENT_TONES = { ppt: 'blue', gongwen: 'accent', research: 'accent', poster: 'rose', ocr: 'blue', health: 'green', weather: 'gold', market: 'gold' };
export const agentIcon = (name) => AGENT_ICONS[name] || AGENT_ICONS.spark;
