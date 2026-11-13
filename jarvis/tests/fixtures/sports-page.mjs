/** 虚构赛程页，与公开页面data-*结构一致；不含客户截图或真实投注。 */
export const pageMatch = (id, date, home, away = '客队', league = '英超', sport = 'football') => `<li id="saishi${id}" data-time="${date}" data-type="${sport}" data-rightishome="0"><b><span class="_league">${league}</span><span class="_teams">${home}<span> - </span>${away}</span></b></li>`;
