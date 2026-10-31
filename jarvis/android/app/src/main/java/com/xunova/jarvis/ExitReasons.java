package com.xunova.jarvis;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.os.Build;

import java.io.InputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 系统记下的进程退出原因（安卓 11+）：哪个进程、为什么退出、系统的说明；
 * 原生崩溃（安卓 12+）再从系统的崩溃记录里摘出能读懂的几行（崩在哪个库、哪个函数）。
 * 这是找到“界面渲染进程崩溃”真正触发点的唯一证据，只记文字，不含聊天内容。
 */
final class ExitReasons {
    private ExitReasons() { }

    static String reasonName(int r) {
        switch (r) {
            case 2: return "自己退出";
            case 3: return "系统回收（内存不足）";
            case 4: return "程序崩溃（Java）";
            case 5: return "原生崩溃";
            case 6: return "无响应";
            case 7: return "初始化失败";
            case 8: return "权限变化";
            case 9: return "资源超限";
            case 10: return "用户关闭";
            case 11: return "用户关闭（多个应用）";
            case 12: return "依赖的组件退出";
            case 13: return "其他原因";
            case 14: return "被系统冻结";
            default: return "代码 " + r;
        }
    }

    /** 从系统的原生崩溃记录（二进制）里摘出可读的文字：信号、终止信息、库名和函数名 */
    static List<String> readableLines(byte[] data, int max) {
        List<String> out = new ArrayList<>();
        StringBuilder run = new StringBuilder();
        for (int i = 0; i <= data.length && out.size() < max; i++) {
            int b = i < data.length ? data[i] & 0xff : 0;
            if (b >= 0x20 && b < 0x7f) { run.append((char) b); continue; }
            if (run.length() >= 6) {
                String s = run.toString();
                if (s.contains(".so") || s.contains("SIG") || s.contains("Abort") || s.contains("abort") || s.contains("chromium") || s.contains("Check failed") || s.startsWith("_Z")) {
                    if (!out.contains(s)) out.add(s.length() > 160 ? s.substring(0, 160) : s);
                }
            }
            run.setLength(0);
        }
        return out;
    }

    /**
     * since 之后、未央主进程的退出记录（给网页分类显示：被系统后台管理关掉 / 安装更新 / 崩溃……）
     * 网页渲染的沙盒进程每次都跟着主进程退出（“isolated not needed”），不算
     */
    static org.json.JSONArray mainSince(Context ctx, long since) {
        org.json.JSONArray out = new org.json.JSONArray();
        if (Build.VERSION.SDK_INT < 30) return out;
        try {
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            for (ApplicationExitInfo e : am.getHistoricalProcessExitReasons(ctx.getPackageName(), 0, 8)) {
                if (e.getTimestamp() <= since || !ctx.getPackageName().equals(e.getProcessName())) continue;
                org.json.JSONObject row = new org.json.JSONObject();
                row.put("time", e.getTimestamp());
                row.put("reason", e.getReason());
                row.put("pssMB", e.getPss() / 1024);
                row.put("description", e.getDescription() == null ? "" : e.getDescription());
                out.put(row);
            }
        } catch (Exception ignored) { /* 读不到就当没有 */ }
        return out;
    }

    /** since 之后的退出记录，每条一行；没有或系统不支持时返回空字符串 */
    static String since(Context ctx, long since) {
        if (Build.VERSION.SDK_INT < 30) return "";
        StringBuilder out = new StringBuilder();
        try {
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            SimpleDateFormat fmt = new SimpleDateFormat("MM-dd HH:mm:ss", Locale.CHINA);
            for (ApplicationExitInfo e : am.getHistoricalProcessExitReasons(ctx.getPackageName(), 0, 8)) {
                if (e.getTimestamp() <= since) continue;
                out.append("系统退出记录 ").append(fmt.format(new Date(e.getTimestamp())))
                    .append(" 进程=").append(e.getProcessName())
                    .append(" 原因=").append(reasonName(e.getReason()))
                    .append(" status=").append(e.getStatus())
                    .append(" 内存PSS=").append(e.getPss() / 1024).append("MB");
                if (e.getDescription() != null) out.append(" 说明=").append(e.getDescription());
                if (e.getReason() == 5 && Build.VERSION.SDK_INT >= 31) {
                    try (InputStream in = e.getTraceInputStream()) {
                        if (in != null) {
                            byte[] buf = new byte[256 * 1024];
                            int n = 0, r;
                            while (n < buf.length && (r = in.read(buf, n, buf.length - n)) > 0) n += r;
                            byte[] data = new byte[n];
                            System.arraycopy(buf, 0, data, 0, n);
                            List<String> lines = readableLines(data, 12);
                            if (!lines.isEmpty()) out.append(" 崩溃记录：").append(String.join(" | ", lines));
                        }
                    } catch (Exception ignored) { /* 读不到崩溃记录就只记原因 */ }
                }
                out.append('\n');
            }
        } catch (Exception e) {
            return "读取系统退出记录失败：" + e.getMessage();
        }
        return out.toString().trim();
    }
}
