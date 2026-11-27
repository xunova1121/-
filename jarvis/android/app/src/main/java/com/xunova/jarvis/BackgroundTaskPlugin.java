package com.xunova.jarvis;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name="BackgroundTask")
public class BackgroundTaskPlugin extends Plugin {
    @Override protected void handleOnDestroy() { getContext().stopService(new Intent(getContext(),TaskService.class)); }
    private boolean canNotify() {
        return Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }
    /** 第一次交任务时问一次能不能发通知（安卓 13 起要用户允许；不允许也不影响用） */
    @PluginMethod public void askNotify(PluginCall call) {
        if (!canNotify() && getActivity() != null) ActivityCompat.requestPermissions(getActivity(), new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 7071);
        call.resolve();
    }
    /** 任务做完了（App 在后台）：发一条通知，点开回到未央 */
    @PluginMethod public void notifyDone(PluginCall call) {
        try {
            if (!canNotify()) { call.resolve(); return; }
            NotificationManager manager = getContext().getSystemService(NotificationManager.class);
            if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel("weiyang_done", "任务完成提醒", NotificationManager.IMPORTANCE_DEFAULT));
            Intent launch = new Intent(getContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent open = PendingIntent.getActivity(getContext(), 9, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            String title = call.getString("title", "未央做完了");
            String body = call.getString("body", "");
            manager.notify((int) (System.currentTimeMillis() % 100000) + 100, new NotificationCompat.Builder(getContext(), "weiyang_done")
                .setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle(title).setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body)).setAutoCancel(true).setContentIntent(open).build());
            call.resolve();
        } catch (Exception e) { call.reject("通知发不出去：" + e.getMessage()); }
    }
    /** 后台待命（常驻通知）开关：on 不传就只读当前状态 */
    @PluginMethod public void standby(PluginCall call) {
        Boolean on = call.getBoolean("on");
        if (on != null) {
            if (on && !canNotify() && getActivity() != null) ActivityCompat.requestPermissions(getActivity(), new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 7072);
            StandbyService.apply(getContext(), on);
        }
        com.getcapacitor.JSObject r = new com.getcapacitor.JSObject();
        r.put("on", StandbyService.enabled(getContext()));
        call.resolve(r);
    }
    @PluginMethod public void set(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                boolean active = call.getBoolean("active", false);
                Intent service = new Intent(getContext(),TaskService.class);
                if (active) { if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(service); else getContext().startService(service); }
                else getContext().stopService(service);
                if (Build.VERSION.SDK_INT >= 26) getBridge().getWebView().setRendererPriorityPolicy(android.webkit.WebView.RENDERER_PRIORITY_IMPORTANT,!active);
                call.resolve();
            } catch (Exception e) { call.reject("后台任务保护未开启：" + e.getMessage()); }
        });
    }
}
