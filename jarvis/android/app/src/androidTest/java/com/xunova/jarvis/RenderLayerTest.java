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
    @Test public void recoveryAppliesSoftwareLayerToActualChatViewAndRestoresDefault() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SharedPreferences prefs = context.getSharedPreferences("render-health", Context.MODE_PRIVATE);
        boolean hadSafe = prefs.contains("safeDisplay"), wasSafe = prefs.getBoolean("safeDisplay", false);
        boolean hadSoftware = prefs.contains("softwareLayer"), wasSoftware = prefs.getBoolean("softwareLayer", false);
        prefs.edit().putBoolean("safeDisplay", true).putBoolean("softwareLayer", true).commit();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                WebView web = activity.getBridge().getWebView();
                assertEquals(View.LAYER_TYPE_SOFTWARE, web.getLayerType());
                assertTrue(activity.usesSoftwareDrawing());
                activity.restoreDefaultDrawing();
                assertEquals(View.LAYER_TYPE_NONE, web.getLayerType());
                assertFalse(activity.usesSoftwareDrawing());
            });
        } finally {
            SharedPreferences.Editor restore = prefs.edit();
            if (hadSafe) restore.putBoolean("safeDisplay", wasSafe); else restore.remove("safeDisplay");
            if (hadSoftware) restore.putBoolean("softwareLayer", wasSoftware); else restore.remove("softwareLayer");
            restore.commit();
        }
    }
}
