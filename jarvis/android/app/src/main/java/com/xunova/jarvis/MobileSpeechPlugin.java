package com.xunova.jarvis;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import java.util.ArrayList;

/** 一句一次的系统识别：结果真正返回后才完成 start，不依赖厂商的 partialResults 行为。 */
@CapacitorPlugin(name = "MobileSpeech", permissions = { @Permission(alias = "speechRecognition", strings = { Manifest.permission.RECORD_AUDIO }) })
public class MobileSpeechPlugin extends Plugin {
    private SpeechRecognizer recognizer;
    private PluginCall pending;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable timeout;
    private ArrayList<String> partial;
    private void dialog(boolean active) { JSObject s = new JSObject(); s.put("active",active); notifyListeners("dialog",s); }
    private void state(String phase) { JSObject s = new JSObject(); s.put("phase",phase); notifyListeners("state",s); }
    private Intent intent() {
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        return i;
    }
    @PluginMethod public void available(PluginCall call) {
        JSObject r = new JSObject();
        r.put("service",SpeechRecognizer.isRecognitionAvailable(getContext()));
        r.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()) || intent().resolveActivity(getContext().getPackageManager()) != null);
        call.resolve(r);
    }
    @PluginMethod public void start(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (pending != null) { call.reject("识别器正在使用中"); return; }
            pending = call; partial = null;
            timeout = () -> finish(partial, partial == null ? "语音识别超时：系统没有返回结果" : null);
            handler.postDelayed(timeout, 30000);
            if (call.getBoolean("popup",false) || !SpeechRecognizer.isRecognitionAvailable(getContext())) {
                try { dialog(true); startActivityForResult(call, intent(), "speechResult"); }
                catch (Exception e) { finish(null, "手机没有可用的中文语音识别服务，请安装或启用系统语音输入"); }
                return;
            }
            try {
                recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                recognizer.setRecognitionListener(new RecognitionListener() {
                    public void onReadyForSpeech(Bundle b) { if (pending == call) state("ready"); }
                    public void onBeginningOfSpeech() { if (pending == call) state("speech"); }
                    public void onRmsChanged(float rms) { if (pending == call) { JSObject s = new JSObject(); s.put("energy",Math.max(0,Math.min(1,rms/12))); notifyListeners("energy",s); } }
                    public void onBufferReceived(byte[] b) { }
                    public void onEndOfSpeech() { if (pending == call) state("processing"); }
                    public void onEvent(int type, Bundle b) { }
                    public void onPartialResults(Bundle b) {
                        if (pending != call) return;
                        ArrayList<String> m = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        if (m != null && !m.isEmpty()) { partial = m; JSObject r = new JSObject(); r.put("text", m.get(0)); notifyListeners("interim", r); }
                    }
                    public void onResults(Bundle b) { if (pending == call) finish(b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION), null); }
                    public void onError(int code) {
                        if (pending != call) return;
                        if (code == SpeechRecognizer.ERROR_NO_MATCH && partial != null) { finish(partial,null); return; }
                        String error = code == SpeechRecognizer.ERROR_NO_MATCH ? "No match" : code == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ? "No speech" : code == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ? "麦克风权限被拒绝" : "系统语音识别失败（错误 " + code + "），请检查系统语音服务与网络";
                        finish(null, error);
                    }
                });
                recognizer.startListening(intent());
            } catch (Exception e) { finish(null, "系统识别无法启动：" + e.getMessage()); }
        });
    }
    @ActivityCallback private void speechResult(PluginCall call, ActivityResult result) {
        if (call == null || pending != call) return;
        dialog(false);
        Intent data = result.getData();
        finish(data == null ? null : data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS), data == null ? "No speech" : null);
    }
    private void finish(ArrayList<String> matches, String error) {
        PluginCall call = pending; pending = null;
        if (timeout != null) handler.removeCallbacks(timeout);
        if (recognizer != null) { SpeechRecognizer old = recognizer; recognizer = null; old.cancel(); old.destroy(); }
        dialog(false);
        if (call == null) return;
        if (error != null) call.reject(error);
        else { JSObject r = new JSObject(); r.put("matches", matches == null ? new JSArray() : new JSArray(matches)); call.resolve(r); }
    }
    @PluginMethod public void stop(PluginCall call) { getActivity().runOnUiThread(() -> { finish(null, "No speech"); call.resolve(); }); }
    @Override protected void handleOnDestroy() { getActivity().runOnUiThread(() -> finish(null, "No speech")); }
}
