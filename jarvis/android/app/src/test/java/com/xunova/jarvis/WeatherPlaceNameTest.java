package com.xunova.jarvis;
import org.junit.Test;
import static org.junit.Assert.*;
public class WeatherPlaceNameTest {
 @Test public void districtAndCityArePreserved(){assertEquals("南京市 · 鼓楼区",WeatherPlaceName.label("南京市",WeatherPlaceName.district("南京市","鼓楼区","南京市")));}
 @Test public void streetsAreNotInventedAsDistricts(){assertEquals("",WeatherPlaceName.district("南京市","新街口街道","南京市"));assertEquals("当前位置",WeatherPlaceName.label("",""));}
 @Test public void countiesAndMunicipalDistrictsKeepOriginalNames(){assertEquals("闵行区",WeatherPlaceName.district("上海市","闵行区",null));assertEquals("盱眙县",WeatherPlaceName.district("淮安市",null,"盱眙县"));}
 @Test public void parentCityIsNotLabeledAsDistrict(){assertEquals("",WeatherPlaceName.district("鼓楼区",null,"南京市"));}
}
