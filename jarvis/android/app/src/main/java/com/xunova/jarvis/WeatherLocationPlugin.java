package com.xunova.jarvis;

import android.Manifest;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.location.Geocoder;
import android.location.Address;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.util.List;
import java.util.Locale;

/** 首页一次性粗略定位；无后台定位、无 GPS 精确位置权限。 */
@CapacitorPlugin(name="WeatherLocation", permissions={@Permission(alias="location", strings={Manifest.permission.ACCESS_COARSE_LOCATION})})
public class WeatherLocationPlugin extends Plugin {
    private final Handler handler=new Handler(Looper.getMainLooper());
    private LocationManager manager;
    private LocationListener listener;
    private PluginCall pending;
    private Runnable timeout;
    @PluginMethod public void locate(PluginCall call){
        if(getPermissionState("location")!=PermissionState.GRANTED){requestPermissionForAlias("location",call,"permissionResult");return;}
        getActivity().runOnUiThread(()->begin(call));
    }
    @PermissionCallback private void permissionResult(PluginCall call){
        if(getPermissionState("location")!=PermissionState.GRANTED){call.reject("定位未允许，可以手动选择城市");return;}
        getActivity().runOnUiThread(()->begin(call));
    }
    private void clean(){if(manager!=null&&listener!=null)try{manager.removeUpdates(listener);}catch(Exception ignored){}listener=null;if(timeout!=null)handler.removeCallbacks(timeout);timeout=null;}
    private void fail(String text){PluginCall call=pending;pending=null;clean();if(call!=null)call.reject(text);}
    private void begin(PluginCall call){
        if(pending!=null){call.reject("正在获取位置，请稍候");return;}
        pending=call;
        try{
            manager=(LocationManager)getContext().getSystemService(android.content.Context.LOCATION_SERVICE);
            if(manager==null||!manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)){fail("请打开系统定位，或手动选择城市");return;}
            timeout=()->fail("暂时没有定位结果，可以手动选择城市");handler.postDelayed(timeout,12000);
            Location last=manager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            if(last!=null&&android.os.SystemClock.elapsedRealtimeNanos()-last.getElapsedRealtimeNanos()>=0&&android.os.SystemClock.elapsedRealtimeNanos()-last.getElapsedRealtimeNanos()<600000000000L){finish(last);return;}
            listener=new LocationListener(){public void onLocationChanged(Location p){finish(p);}public void onProviderDisabled(String p){fail("系统定位已关闭，可以手动选择城市");}public void onProviderEnabled(String p){}public void onStatusChanged(String p,int s,Bundle b){}};
            manager.requestSingleUpdate(LocationManager.NETWORK_PROVIDER,listener,Looper.getMainLooper());
        }catch(Exception error){fail("暂时无法定位，可以手动选择城市");}
    }
    private void finish(Location location){
        final PluginCall call=pending;if(call==null)return;clean();
        // 系统地理编码保留真实区县；无结果时交给和风坐标解析，不猜测行政区。
        timeout=()->resolve(call,location,"当前位置","","");handler.postDelayed(timeout,2500);
        new Thread(()->{
            String city="", district="";
            try {
                List<Address> rows=new Geocoder(getContext(),Locale.SIMPLIFIED_CHINESE).getFromLocation(location.getLatitude(),location.getLongitude(),1);
                if(rows!=null&&!rows.isEmpty()){
                    Address address=rows.get(0);
                    city=WeatherPlaceName.city(address.getLocality(),address.getSubAdminArea(),address.getAdminArea());
                    district=WeatherPlaceName.district(city,address.getSubLocality(),address.getSubAdminArea());
                }
            } catch(Exception ignored) { /* 联网解析另由和风GeoAPI补齐，不伪造区名。 */ }
            final String resolvedCity=city, resolvedDistrict=district;
            handler.post(()->resolve(call,location,WeatherPlaceName.label(resolvedCity,resolvedDistrict),resolvedCity,resolvedDistrict));
        },"weather-city").start();
    }
    private void resolve(PluginCall call,Location p,String place,String city,String district){if(pending!=call)return;pending=null;clean();JSObject result=new JSObject();result.put("name",place);result.put("city",city);result.put("district",district);result.put("latitude",Math.round(p.getLatitude()*100.0)/100.0);result.put("longitude",Math.round(p.getLongitude()*100.0)/100.0);call.resolve(result);}
    @Override protected void handleOnDestroy(){fail("定位已取消");super.handleOnDestroy();}
}
