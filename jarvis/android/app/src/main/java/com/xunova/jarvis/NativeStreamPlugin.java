package com.xunova.jarvis;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 边收边给的原生网络请求：中转站不允许网页跨域调用时，回答走系统网络。
 * 原来的原生请求要等整段回答写完才一次性返回（几十秒里一个字都看不到）；
 * 这里收到一段就通过事件交给网页（head → data… → end / error），回答能一个字一个字出来。
 */
@CapacitorPlugin(name = "NativeStream")
public class NativeStreamPlugin extends Plugin {
    private final Map<String, HttpURLConnection> open = new ConcurrentHashMap<>();
    private final ExecutorService pool = Executors.newCachedThreadPool();

    @PluginMethod
    public void start(PluginCall call) {
        final String id = call.getString("id", "");
        final String url = call.getString("url", "");
        final String method = call.getString("method", "GET");
        final String body = call.getString("body", null);
        final JSObject headers = call.getObject("headers", new JSObject());
        call.resolve();
        pool.execute(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                open.put(id, c);
                c.setRequestMethod(method);
                c.setConnectTimeout(20000);
                c.setReadTimeout(180000);
                c.setUseCaches(false);
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    c.setRequestProperty(k, headers.getString(k));
                }
                if (body != null) {
                    c.setDoOutput(true);
                    try (OutputStream out = c.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
                }
                int status = c.getResponseCode();
                JSObject h = new JSObject();
                for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
                    if (e.getKey() != null && e.getValue() != null && !e.getValue().isEmpty()) h.put(e.getKey(), e.getValue().get(0));
                }
                JSObject head = new JSObject();
                head.put("id", id);
                head.put("status", status);
                head.put("headers", h);
                notifyListeners("head", head);
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                if (in != null) {
                    try (InputStream stream = in) {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = stream.read(buf)) > 0) {
                            JSObject d = new JSObject();
                            d.put("id", id);
                            d.put("data", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP));
                            notifyListeners("data", d);
                        }
                    }
                }
                JSObject end = new JSObject();
                end.put("id", id);
                notifyListeners("end", end);
            } catch (Exception e) {
                JSObject err = new JSObject();
                err.put("id", id);
                err.put("message", String.valueOf(e.getMessage()));
                notifyListeners("error", err);
            } finally {
                open.remove(id);
                if (c != null) c.disconnect();
            }
        });
    }

    /** 用户点了停止：断开这次请求 */
    @PluginMethod
    public void cancel(PluginCall call) {
        final HttpURLConnection c = open.remove(call.getString("id", ""));
        if (c != null) pool.execute(c::disconnect);
        call.resolve();
    }
}
