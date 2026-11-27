package com.xunova.jarvis;

import android.content.Context;
import android.content.SharedPreferences;
import android.view.View;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class RenderLayerTest {
    @Test public void upgradeAfterOneReportedCrashKeepsLightweightUiWithSystemDrawing() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SharedPreferences prefs = context.getSharedPreferences("render-health", Context.MODE_PRIVATE);
        String[] keys = {"safeDisplayManual", "safeDisplayLimited", "lastCrash", "softwareLayer",
                "softwareRecoveryVersion", "lastRenderer", "hardwareCrashVersion", "softwareRescueAt"};
        java.util.Map<String, ?> previous = prefs.getAll();
        prefs.edit().putBoolean("safeDisplayManual", false).putBoolean("safeDisplayLimited", true)
                .putLong("lastCrash", System.currentTimeMillis()).putBoolean("softwareLayer", false)
                .putString("softwareRecoveryVersion", "114.0.5.302")
                .putString("lastRenderer", "App=1.0.480，WebView=114.0.5.302，didCrash=true，lowMemory=false，连续=1，软件绘制=false，兼容显示开")
                .remove("hardwareCrashVersion").remove("softwareRescueAt").commit();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                assertTrue(MainActivity.safeDisplay(activity));
                assertEquals(View.LAYER_TYPE_NONE, activity.getBridge().getWebView().getLayerType());
                assertFalse(activity.usesSoftwareDrawing());
            });
        } finally {
            SharedPreferences.Editor restore = prefs.edit();
            for (String key : keys) {
                Object value = previous.get(key);
                if (value instanceof Boolean b) restore.putBoolean(key, b);
                else if (value instanceof Long n) restore.putLong(key, n);
                else if (value instanceof String s) restore.putString(key, s);
                else restore.remove(key);
            }
            restore.commit();
        }
    }

    @Test public void recoveryAppliesSoftwareLayerToActualChatViewAndRestoresDefault() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SharedPreferences prefs = context.getSharedPreferences("render-health", Context.MODE_PRIVATE);
        boolean hadSafe = prefs.contains("safeDisplay"), wasSafe = prefs.getBoolean("safeDisplay", false);
        boolean hadSoftware = prefs.contains("softwareLayer"), wasSoftware = prefs.getBoolean("softwareLayer", false);
        boolean hadRoomCrash = prefs.contains("workshopCrashAt");
        long previousRoomCrash = prefs.getLong("workshopCrashAt", 0);
        prefs.edit().putBoolean("safeDisplay", true).putBoolean("softwareLayer", true).remove("workshopCrashAt").commit();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                WebView web = activity.getBridge().getWebView();
                assertEquals(View.LAYER_TYPE_SOFTWARE, web.getLayerType());
                assertTrue(activity.usesSoftwareDrawing());
                long revision = System.currentTimeMillis();
                assertTrue(activity.setWorkshopDrawing(true, revision).optBoolean("active"));
                assertEquals(View.LAYER_TYPE_NONE, web.getLayerType());
                assertFalse(activity.usesSoftwareDrawing());
                assertFalse(activity.setWorkshopDrawing(false, revision + 2).optBoolean("active"));
                assertEquals(View.LAYER_TYPE_SOFTWARE, web.getLayerType());
                assertEquals("stale", activity.setWorkshopDrawing(true, revision + 1).optString("status"));
                assertEquals(View.LAYER_TYPE_SOFTWARE, web.getLayerType());
                activity.setWorkshopDrawing(true, revision + 3);
                activity.restoreDefaultDrawing();
                activity.setWorkshopDrawing(false, revision + 4);
                assertEquals(View.LAYER_TYPE_NONE, web.getLayerType());
                assertFalse(activity.usesSoftwareDrawing());
            });
        } finally {
            SharedPreferences.Editor restore = prefs.edit();
            if (hadSafe) restore.putBoolean("safeDisplay", wasSafe); else restore.remove("safeDisplay");
            if (hadSoftware) restore.putBoolean("softwareLayer", wasSoftware); else restore.remove("softwareLayer");
            if (hadRoomCrash) restore.putLong("workshopCrashAt", previousRoomCrash); else restore.remove("workshopCrashAt");
            restore.commit();
        }
    }
}
