package com.xunova.jarvis;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 手机自动更新：后台下载新版 APK 到应用缓存，下载好后打开系统安装界面。
 * 安卓不允许普通应用静默安装，最后一步需要用户在系统界面点“安装”；
 * 第一次还要允许未央“安装未知应用”（没有权限时打开对应的设置页）。
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {
    private File apk() { return new File(getContext().getCacheDir(), "update.apk"); }

    /** download({ url, size }) → 下载过程中发 progress 事件 { percent } */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) { call.reject("下载地址不对"); return; }
        new Thread(() -> {
            File part = new File(getContext().getCacheDir(), "update.apk.part");
            try {
                HttpURLConnection c = open(url);
                long total = c.getContentLengthLong();
                if (total <= 0) total = call.getLong("size", 0L);
                try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                    byte[] buf = new byte[64 * 1024];
                    long done = 0; int last = -1, n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        done += n;
                        int p = total > 0 ? (int) (done * 100 / total) : 0;
                        if (p != last) { last = p; JSObject e = new JSObject(); e.put("percent", p); notifyListeners("progress", e); }
                    }
                }
                if (!part.renameTo(apk())) throw new Exception("保存安装包失败");
                JSObject r = new JSObject();
                r.put("bytes", apk().length());
                call.resolve(r);
            } catch (Exception e) {
                part.delete();
                call.reject("下载失败：" + e.getMessage());
            }
        }).start();
    }

    /** 跟随跳转（GitHub 的下载地址会跳到存储服务器），只允许 https */
    private HttpURLConnection open(String url) throws Exception {
        for (int i = 0; i < 6; i++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setInstanceFollowRedirects(false);
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) {
                String next = c.getHeaderField("Location");
                c.disconnect();
                if (next == null || !next.startsWith("https://")) throw new Exception("跳转地址不对");
                url = next;
                continue;
            }
            if (code != 200) throw new Exception("服务器返回 " + code);
            return c;
        }
        throw new Exception("跳转次数太多");
    }

    /** 打开系统安装界面；没有“安装未知应用”权限时先打开设置页，返回 { needPermission: true } */
    @PluginMethod
    public void install(PluginCall call) {
        File f = apk();
        if (!f.exists()) { call.reject("还没有下载安装包"); return; }
        JSObject r = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(s);
            r.put("needPermission", true);
            call.resolve(r);
            return;
        }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getActivity().startActivity(i);
        r.put("needPermission", false);
        call.resolve(r);
    }

    /** 已下载的安装包（装好新版后清掉，免得占空间） */
    @PluginMethod
    public void clear(PluginCall call) {
        apk().delete();
        call.resolve();
    }
}
