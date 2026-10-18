
package com.xunova.jarvis;

import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import java.net.URI;
import java.util.HashMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/** 仅连接百炼的两个固定实时模型；密钥放请求头，不放URL、不写日志。复用已有Java-WebSocket依赖。 */
@CapacitorPlugin(name = "QwenRealtime")
public class QwenRealtimePlugin extends Plugin {
    private final ConcurrentHashMap<String, WebSocketClient> sockets = new ConcurrentHashMap<>();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private void event(String id, String phase, String data) {
        JSObject e = new JSObject(); e.put("id", id); e.put("phase", phase);
        if (data != null) e.put("data", data);
        notifyListeners("event", e);
    }
    @PluginMethod public void connect(PluginCall call) {
        String id = call.getString("id", "");
        String model = call.getString("model", "");
        String region = call.getString("region", "beijing");
        String key = call.getString("key", "");
        if (!id.matches("[a-zA-Z0-9-]{1,80}") || sockets.containsKey(id) || sockets.size() >= 4 ||
            !(model.equals("qwen3-asr-flash-realtime") || model.equals("qwen3-tts-flash-realtime")) ||
            !(region.equals("beijing") || region.equals("singapore")) ||
            key.isEmpty() || key.length() > 2048 || key.contains("\r") || key.contains("\n")) {
            call.reject("百炼实时语音配置不正确或连接过多"); return;
        }
        AtomicBoolean settled = new AtomicBoolean();
        final Runnable[] timeout = new Runnable[1];
        try {
            String host = region.equals("beijing") ? "dashscope.aliyuncs.com" : "dashscope-intl.aliyuncs.com";
            HashMap<String, String> headers = new HashMap<>();
            headers.put("Authorization", "Bearer " + key); headers.put("OpenAI-Beta", "realtime=v1");
            WebSocketClient client = new WebSocketClient(URI.create("wss://" + host + "/api-ws/v1/realtime?model=" + model), headers) {
                @Override public void onOpen(ServerHandshake handshake) {
                    handler.removeCallbacks(timeout[0]);
                    if (sockets.get(id) != this) { close(); if(settled.compareAndSet(false,true))call.reject("连接已取消"); return; }
                    if(settled.compareAndSet(false,true))call.resolve();
                }
                @Override public void onMessage(String message) {
                    if(sockets.get(id) != this)return;
                    if(message.length() > 1024 * 1024) { close(); event(id,"error",null); return; }
                    event(id,"message",message);
                }
                @Override public void onClose(int code, String reason, boolean remote) {
                    handler.removeCallbacks(timeout[0]); sockets.remove(id,this);
                    if(settled.compareAndSet(false,true))call.reject("百炼实时连接已关闭，请检查网络与配置");
                    event(id,"close",null);
                }
                @Override public void onError(Exception error) {
                    handler.removeCallbacks(timeout[0]); sockets.remove(id,this);
                    if(settled.compareAndSet(false,true))call.reject("百炼实时连接失败，请检查密钥、地域、网络与额度");
                    event(id,"error",null); close();
                }
            };
            timeout[0] = () -> { sockets.remove(id,client); client.close(); if(settled.compareAndSet(false,true))call.reject("百炼实时连接超时"); };
            sockets.put(id,client); handler.postDelayed(timeout[0],15000); client.connect();
        } catch(Exception error) {
            sockets.remove(id); if(timeout[0] != null)handler.removeCallbacks(timeout[0]);
            if(settled.compareAndSet(false,true))call.reject("无法建立百炼实时连接");
        }
    }
    @PluginMethod public void send(PluginCall call) {
        WebSocketClient client = sockets.get(call.getString("id",""));
        String data = call.getString("data","");
        if(client == null || !client.isOpen() || data.length() > 256 * 1024) { call.reject("实时连接不可用或数据过大"); return; }
        try { client.send(data); call.resolve(); } catch(Exception error) { call.reject("实时语音发送失败"); }
    }
    @PluginMethod public void close(PluginCall call) {
        WebSocketClient client = sockets.remove(call.getString("id",""));
        if(client != null)client.close();
        call.resolve();
    }
    private void closeAll() { for(WebSocketClient client:sockets.values())client.close(); sockets.clear(); }
    @Override protected void handleOnPause() { closeAll(); }
    @Override protected void handleOnDestroy() { closeAll(); }
}
