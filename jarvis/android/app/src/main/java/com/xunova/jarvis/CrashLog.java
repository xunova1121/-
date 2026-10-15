package com.xunova.jarvis;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 闪退记录：程序出错退出、网页渲染进程被系统杀掉时，把原因写进 crash.txt；
 * 下次打开时由 CrashLogPlugin 交给网页显示，用户截图就能知道是怎么退出的。
 */
public final class CrashLog {
    private CrashLog() {}

    static File file(Context ctx) { return new File(ctx.getFilesDir(), "crash.txt"); }

    static void write(Context ctx, String text) {
        try (FileOutputStream out = new FileOutputStream(file(ctx), true)) {
            String time = new SimpleDateFormat("MM-dd HH:mm:ss", Locale.CHINA).format(new Date());
            out.write((time + " " + text + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) { }
    }

    /** 程序级未捕获的异常：记下来，再交给系统原来的处理（照常退出） */
    static void install(Context ctx) {
        final Context app = ctx.getApplicationContext();
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            StringWriter sw = new StringWriter();
            e.printStackTrace(new PrintWriter(sw));
            String s = sw.toString();
            write(app, "程序出错（线程 " + t.getName() + "）：" + (s.length() > 1500 ? s.substring(0, 1500) : s));
            if (prev != null) prev.uncaughtException(t, e);
        });
    }

    static String take(Context ctx) {
        File f = file(ctx);
        if (!f.exists()) return "";
        try {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            try (InputStream in = new FileInputStream(f)) {
                byte[] b = new byte[8192];
                int n;
                while ((n = in.read(b)) > 0) buf.write(b, 0, n);
            }
            String s = new String(buf.toByteArray(), StandardCharsets.UTF_8);
            f.delete();
            return s.length() > 3000 ? s.substring(s.length() - 3000) : s;
        } catch (Exception e) {
            f.delete();
            return "";
        }
    }
}
