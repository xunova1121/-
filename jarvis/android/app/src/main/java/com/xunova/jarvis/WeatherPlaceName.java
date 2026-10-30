package com.xunova.jarvis;

/** 只组合系统返回的行政区，不把街道名猜成区县。 */
public final class WeatherPlaceName {
    private WeatherPlaceName() {}
    public static String city(String... values) {
        for(String value:values) if(value!=null&&!value.trim().isEmpty()) return value.trim();
        return "";
    }
    public static String district(String city, String... values) {
        for(String value:values) {
            if(value==null) continue;
            String text=value.trim();
            // “市”可能是上级地级市，系统字段不明确时让GeoAPI核对，不能倒置城市/区县。
            if(!text.equals(city)&&text.matches(".{1,40}[区县旗]$")) return text;
        }
        return "";
    }
    public static String label(String city,String district) {
        if(district!=null&&!district.isEmpty()) return city==null||city.isEmpty()?district:city+" · "+district;
        return city==null||city.isEmpty()?"当前位置":city;
    }
}
