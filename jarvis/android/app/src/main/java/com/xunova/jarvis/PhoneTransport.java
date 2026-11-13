package com.xunova.jarvis;

import com.getcapacitor.JSObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** 手机主动连接本人服务器，设备凭据只驻内存；不监听手机端口、不接受重定向。 */
final class PhoneTransport {
    private final PhoneAccessibilityService service;
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private final String endpoint, deviceId, token;
    private volatile boolean closed;
    private int failures;
    PhoneTransport(PhoneAccessibilityService service, String base, String deviceId, String token) throws Exception {
        URL url = new URL(base);
        if (!PhonePolicy.secureTransport(url.getProtocol(), url.getHost()) || url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null || !token.matches("phone_[A-Za-z0-9_-]{43}")) throw new Exception("PHONE_HTTPS_REQUIRED");
        this.service = service; this.endpoint = base.replaceAll("/+$", "") + "/api/phone/transport"; this.deviceId = deviceId; this.token = token;
    }
    void start() { worker.scheduleWithFixedDelay(this::poll, 0, 1500, TimeUnit.MILLISECONDS); }
    void close() { closed = true; worker.shutdownNow(); }
    private JSObject post(JSObject data) throws Exception {
        if (closed) throw new Exception("PHONE_STOPPED");
        data.put("deviceId", deviceId);
        HttpURLConnection connection = (HttpURLConnection)new URL(endpoint).openConnection();
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(5000); connection.setReadTimeout(7000); connection.setRequestMethod("POST"); connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json"); connection.setRequestProperty("Authorization", "Bearer " + token);
        try {
            byte[] bytes = data.toString().getBytes(StandardCharsets.UTF_8); connection.setFixedLengthStreamingMode(bytes.length); try (java.io.OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            int code = connection.getResponseCode();
            if (code == 401 || code == 403) throw new Exception("PHONE_AUTH");
            if (code != 200) throw new Exception("PHONE_EXPIRED");
            try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) { byte[] buffer = new byte[4096]; int n; while ((n = in.read(buffer)) != -1) { if (out.size() + n > 40000) throw new Exception("PHONE_RESULT_LIMIT"); out.write(buffer, 0, n); } return new JSObject(out.toString("UTF-8")); }
        } finally { connection.disconnect(); }
    }
    private void poll() {
        if (closed) return;
        if (!service.enabled()) { service.main.post(() -> { if (!closed) service.stop(); }); return; }
        try {
            JSObject request = new JSObject(); request.put("op", "poll"); request.put("paused", service.paused);
            JSObject reply = post(request); if (closed) return; failures = 0;
            org.json.JSONObject value = reply.optJSONObject("command");
            if (value != null) {
                JSObject command = new JSObject(value.toString());
                service.main.post(() -> { if (!closed) service.execute(command, result -> complete(command.optString("id"), result), this::validate); });
            } else {
                String active = reply.optString("activeId");
                service.main.post(() -> { if (!closed && service.remotePending() && !service.pendingId().equals(active)) service.cancel(service.pendingId()); });
            }
        } catch (Exception error) {
            if ("PHONE_AUTH".equals(error.getMessage()) || ++failures >= 3) service.main.post(() -> { if (!closed) service.stop(); });
        }
    }
    void validate(String id, Runnable valid, Runnable invalid) {
        if (closed) { service.main.post(invalid); return; }
        try { worker.execute(() -> {
            try { JSObject r = new JSObject(); r.put("op", "validate"); r.put("commandId", id); post(r); service.main.post(() -> { if (!closed) valid.run(); else invalid.run(); }); }
            catch (Exception e) { service.main.post(invalid); }
        }); } catch (java.util.concurrent.RejectedExecutionException e) { service.main.post(invalid); }
    }
    private void complete(String id, JSObject result) {
        if (closed) return;
        try { worker.execute(() -> { try { JSObject r = new JSObject(); r.put("op", "complete"); r.put("commandId", id); r.put("result", result); post(r); } catch (Exception ignored) { /* 只丢回执，不重放手机操作；服务器最终明确显示结果未知。 */ } }); } catch (java.util.concurrent.RejectedExecutionException ignored) { /* 已停止 */ }
    }
}
