import { createWeatherClient } from '../core/weather.js';
import { qweatherConfig } from '../core/qweather.js';

/** 云端Key不下发到手机；运行位置变化时从当前服务器或本机重新取天气。 */
export function createHomepageWeather({ getServer, getConfig, direct, ...options }) {
  return createWeatherClient({
    ...options,
    direct,
    qweather: () => qweatherConfig(getConfig()),
    transport: () => {
      const server = getServer();
      if (!server) return null;
      let identity;
      try {
        const address = new URL(server.base);
        identity = address.origin + address.pathname;
      } catch {
        identity = 'invalid-server';
      }
      return {
        id: 'server:' + identity,
        weather: (city, signal) => server.weather(city, signal),
        cities: (query, signal) => server.weatherCities(query, signal)
      };
    }
  });
}
