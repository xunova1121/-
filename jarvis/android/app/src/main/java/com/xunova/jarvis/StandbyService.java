package com.xunova.jarvis;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

/**
 * 后台待命（设置里的“常驻通知”，默认关）：挂一条静音通知，让系统把未央当作在工作的应用，少被后台管理关掉。
 * 不持有唤醒锁、不录音、不联网；用户在最近任务里划掉未央就停。
 */
public class StandbyService extends Service {
    static final String PREFS = "standby";
    static boolean enabled(Context ctx) { return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("on", false); }
    static void apply(Context ctx, boolean on) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("on", on).apply();
        Intent service = new Intent(ctx, StandbyService.class);
        try {
            if (!on) ctx.stopService(service);
            else if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(service);
            else ctx.startService(service);
        } catch (Exception e) { CrashLog.write(ctx, "后台待命没开起来：" + e.getMessage()); }
    }
    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel("weiyang_standby", "未央后台待命", NotificationManager.IMPORTANCE_MIN);
            channel.setSound(null, null); channel.enableVibration(false); channel.setShowBadge(false); manager.createNotificationChannel(channel);
        }
        Intent launch = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent open = PendingIntent.getActivity(this, 10, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        startForeground(89, new NotificationCompat.Builder(this, "weiyang_standby").setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("未央在后台待命").setContentText("减少被手机后台管理关掉；不用时在设置里关掉").setContentIntent(open)
            .setOngoing(true).setSilent(true).setPriority(NotificationCompat.PRIORITY_MIN).build());
    }
    @Override public int onStartCommand(Intent intent, int flags, int id) { return START_NOT_STICKY; }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onTaskRemoved(Intent intent) { stopSelf(); }
    @Override public void onTimeout(int startId, int type) { stopSelf(); }
}
