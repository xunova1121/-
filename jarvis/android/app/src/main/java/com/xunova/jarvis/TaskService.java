package com.xunova.jarvis;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

/** 用户已开始的任务在后台继续执行；通知静音，不持有麦克风。 */
public class TaskService extends Service {
    public static volatile boolean running = false;
    private PowerManager.WakeLock wake;
    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel("weiyang_tasks", "未央任务进度", NotificationManager.IMPORTANCE_LOW);
            channel.setSound(null, null); channel.enableVibration(false); manager.createNotificationChannel(channel);
        }
        Intent launch = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent open = PendingIntent.getActivity(this, 8, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        startForeground(88, new NotificationCompat.Builder(this,"weiyang_tasks").setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("未央正在完成任务").setContentText("切换应用后任务继续，结果保存在对话中").setContentIntent(open)
            .setOngoing(true).setSilent(true).build());
        wake = ((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"Jarvis:activeTask");
        try { wake.acquire(30 * 60 * 1000L); } catch (Exception e) { CrashLog.write(this,"后台任务唤醒锁不可用：" + e.getMessage()); }
        running = true;
    }
    @Override public int onStartCommand(Intent intent,int flags,int id) { return START_NOT_STICKY; }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onTaskRemoved(Intent intent) { stopSelf(); }
    @Override public void onDestroy() { running = false; if (wake != null && wake.isHeld()) wake.release(); super.onDestroy(); }
    @Override public void onTimeout(int startId,int type) { stopSelf(); }
}
