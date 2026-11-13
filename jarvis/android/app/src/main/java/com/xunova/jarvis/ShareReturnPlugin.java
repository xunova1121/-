package com.xunova.jarvis;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 只提供用户可点的返回入口；不控制微信、不抢前台、不开启常驻服务或申请权限。 */
@CapacitorPlugin(name = "ShareReturn")
public class ShareReturnPlugin extends Plugin {
    private static final int NOTIFICATION_ID = 90;
    private static final int REQUEST_CODE = 11;
    private static final String CHANNEL = "weiyang_share_return";
    private ShareReturnController controller;

    private void stage(String value) {
        // 固定阶段供手动诊断；不写CrashLog，避免把正常分享当成闪退弹窗。
        getContext().getSharedPreferences("share-return", Context.MODE_PRIVATE).edit()
            .putString("lastStage", value).putLong("lastStageAt", System.currentTimeMillis()).apply();
    }

    @Override public void load() {
        SharedPreferences prefs = getContext().getSharedPreferences("share-return", Context.MODE_PRIVATE);
        controller = new ShareReturnController(new ShareReturnController.Store() {
            public ShareReturnController.State read() {
                return new ShareReturnController.State(prefs.getString("id", ""), prefs.getLong("startedAt", 0));
            }
            public boolean write(ShareReturnController.State state) {
                return prefs.edit().putString("id", state.id).putLong("startedAt", state.startedAt).commit();
            }
            public void clear() { prefs.edit().remove("id").remove("startedAt").commit(); }
        }, new ShareReturnController.Notifications() {
            private NotificationManager manager() { return getContext().getSystemService(NotificationManager.class); }
            public boolean allowed() {
                if (!ShareReturnController.supportsTimeout(Build.VERSION.SDK_INT)) return false;
                if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
                NotificationManager manager = manager();
                if (manager == null || !manager.areNotificationsEnabled()) return false;
                NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
                return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
            }
            public void show(long remainingMs) {
                NotificationManager manager = manager();
                NotificationChannel channel = new NotificationChannel(CHANNEL, "分享后返回", NotificationManager.IMPORTANCE_LOW);
                channel.setSound(null, null);
                channel.enableVibration(false);
                channel.setShowBadge(false);
                manager.createNotificationChannel(channel);
                Intent launch = new Intent(getContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
                PendingIntent open = PendingIntent.getActivity(getContext(), REQUEST_CODE, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                manager.notify(NOTIFICATION_ID, new NotificationCompat.Builder(getContext(), CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle("返回未央")
                    .setContentText("分享结束后点这里，回到未央继续")
                    .setContentIntent(open).setAutoCancel(true).setSilent(true).setOnlyAlertOnce(true)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setTimeoutAfter(remainingMs).build());
            }
            public void cancel() { NotificationManager manager = manager(); if (manager != null) manager.cancel(NOTIFICATION_ID); }
        });
        controller.expire(System.currentTimeMillis());
    }

    @PluginMethod public void prepare(PluginCall call) {
        try {
            boolean notification = controller.prepare(call.getString("id"), System.currentTimeMillis());
            stage(notification ? "prepare_with_notification" : "prepare_without_notification");
            JSObject result = new JSObject(); result.put("notification", notification); call.resolve(result);
        } catch (IllegalArgumentException invalid) { call.reject("分享返回标识无效"); }
        catch (RuntimeException unavailable) { call.reject("分享返回入口暂不可用"); }
    }

    @PluginMethod public void finish(PluginCall call) {
        try {
            boolean cleared = controller.finish(call.getString("id"));
            stage(cleared ? "finish" : "finish_stale");
            JSObject result = new JSObject(); result.put("cleared", cleared); call.resolve(result);
        } catch (IllegalArgumentException invalid) { call.reject("分享返回标识无效"); }
        catch (RuntimeException unavailable) { call.reject("分享返回状态暂不可用"); }
    }

    @Override protected void handleOnResume() {
        super.handleOnResume();
        SharedPreferences prefs = getContext().getSharedPreferences("share-return", Context.MODE_PRIVATE);
        if (ShareReturnController.remaining(new ShareReturnController.State(prefs.getString("id", ""), prefs.getLong("startedAt", 0)), System.currentTimeMillis()) > 0) stage("resume");
        if (controller != null) controller.expire(System.currentTimeMillis());
    }
    // 不在onDestroy清通知：页面被系统回收时仍应能从通知打开同一个App。
}
