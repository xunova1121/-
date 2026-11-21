/** 和风优先；给两级免费备用留出时间，不能让单个来源耗尽整项查询。 */
export const WEATHER_SOURCE_MS = Object.freeze({ qweather: 5000, openMeteo: 5000, wttr: 3000 });
export const WEATHER_FETCH_MS = 14000;
