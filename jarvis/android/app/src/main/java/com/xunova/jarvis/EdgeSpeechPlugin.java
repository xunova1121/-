package com.xunova.jarvis;

import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.TimeZone;
import java.util.HashMap;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/** 安卓直接连接朗读服务，不依赖电脑网关；协议沿用本项目 server/edgeTts.mjs。 */
@CapacitorPlugin(name = "EdgeSpeech")
public class EdgeSpeechPlugin extends Plugin {
    private static final String TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    private final ConcurrentHashMap<String, WebSocketClient> sockets = new ConcurrentHashMap<>();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private static String escape(String s) { return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&apos;"); }
    @PluginMethod public void synthesize(PluginCall call) {
        String text = call.getString("text", "").trim();
        String id = call.getString("id", UUID.randomUUID().toString());
        String voice = call.getString("voice", "zh-CN-XiaoyiNeural");
        if (text.isEmpty() || text.length() > 1500 || !voice.matches("[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural")) { call.reject("朗读文字或音色不正确"); return; }
        if (sockets.size() >= 3) { call.reject("朗读请求过多，请稍后再试"); return; }
        try {
            String gec = call.getString("gec", "");
            if (!gec.matches("[0-9A-F]{16}-[0-9A-F]{64}")) { call.reject("朗读连接签名不正确，请更新应用"); return; }
            String connectionId = UUID.randomUUID().toString().replace("-", "");
            URI uri = URI.create("wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=" + TOKEN + "&ConnectionId=" + connectionId + "&Sec-MS-GEC=" + gec + "&Sec-MS-GEC-Version=2-143.0.3650.75");
            HashMap<String, String> headers = new HashMap<>();
            headers.put("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold");
            headers.put("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0");
            headers.put("Cookie", "muid=" + UUID.randomUUID().toString().replace("-", "").toUpperCase(Locale.US) + ";");
            final AtomicBoolean done = new AtomicBoolean();
            final ByteArrayOutputStream audio = new ByteArrayOutputStream();
            final Runnable[] timeout = new Runnable[1];
            WebSocketClient client = new WebSocketClient(uri, headers) {
                private void finish(String error) {
                    if (!done.compareAndSet(false, true)) return;
                    handler.removeCallbacks(timeout[0]); sockets.remove(id); close();
                    if (error != null) call.reject(error);
                    else if (audio.size() == 0) call.reject("朗读服务没有返回声音");
                    else { JSObject r = new JSObject(); r.put("audio", Base64.encodeToString(audio.toByteArray(), Base64.NO_WRAP)); call.resolve(r); }
                }
                @Override public void onOpen(ServerHandshake handshake) {
                    SimpleDateFormat format = new SimpleDateFormat("EEE MMM dd yyyy HH:mm:ss 'GMT+0000 (Coordinated Universal Time)'", Locale.US);
                    format.setTimeZone(TimeZone.getTimeZone("UTC"));
                    String stamp = format.format(new Date());
                    send("X-Timestamp:" + stamp + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}\r\n");
                    int pitch = Math.max(-20, Math.min(20, call.getInt("pitch", 8)));
                    String ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='" + voice + "'><prosody pitch='" + (pitch >= 0 ? "+" : "") + pitch + "Hz' rate='-6%' volume='+0%'>" + escape(text) + "</prosody></voice></speak>";
                    send("X-RequestId:" + connectionId + "\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:" + stamp + "Z\r\nPath:ssml\r\n\r\n" + ssml);
                }
                @Override public void onMessage(String message) { if (message.contains("Path:turn.end")) finish(null); }
                @Override public void onMessage(ByteBuffer message) {
                    if (done.get() || message.remaining() < 2) return;
                    int size = (message.getShort() & 0xffff);
                    if (size > message.remaining()) { finish("朗读数据格式错误"); return; }
                    byte[] header = new byte[size]; message.get(header);
                    if (!new String(header, StandardCharsets.UTF_8).contains("Path:audio")) return;
                    if (audio.size() + message.remaining() > 2 * 1024 * 1024) { finish("单句音频过大"); return; }
                    byte[] bytes = new byte[message.remaining()]; message.get(bytes); audio.write(bytes, 0, bytes.length);
                }
                @Override public void onClose(int code, String reason, boolean remote) { finish("朗读连接已关闭（" + code + "）"); }
                @Override public void onError(Exception e) { finish("连不上在线女声：" + e.getMessage()); }
            };
            timeout[0] = () -> { if (done.compareAndSet(false, true)) { sockets.remove(id); client.close(); call.reject("在线女声连接超时，请检查网络"); } };
            sockets.put(id, client); handler.postDelayed(timeout[0], 15000); client.connect();
        } catch (Exception e) { call.reject("在线朗读无法启动：" + e.getMessage()); }
    }
    @PluginMethod public void cancel(PluginCall call) { WebSocketClient c = sockets.remove(call.getString("id", "")); if (c != null) c.close(); call.resolve(); }
    @Override protected void handleOnDestroy() { for (WebSocketClient c : sockets.values()) c.close(); sockets.clear(); }
}
