package com.xunova.jarvis;
import org.junit.Test;
import static org.junit.Assert.*;
public class RenderRecoveryTest {
    @Test public void onlySevereMemoryPressureReducesDisplay(){assertTrue(RenderRecovery.shouldReduceDisplay(15));assertTrue(RenderRecovery.shouldReduceDisplay(80));assertFalse(RenderRecovery.shouldReduceDisplay(20));assertFalse(RenderRecovery.shouldReduceDisplay(40));}
    @Test public void firstCrashRecoversOnce(){int n=RenderRecovery.nextCount(0,0,1000);assertEquals(1,n);assertTrue(RenderRecovery.autoRestart(n));}
    @Test public void repeatedCrashDoesNotLoop(){int n=RenderRecovery.nextCount(1000,1,2000);assertEquals(2,n);assertFalse(RenderRecovery.autoRestart(n));assertFalse(RenderRecovery.autoRestart(100));}
    @Test public void stableWindowStartsNewAttempt(){assertEquals(1,RenderRecovery.nextCount(1000,7,1000+RenderRecovery.WINDOW_MS));}
    @Test public void changedClockDoesNotReuseStreak(){assertEquals(1,RenderRecovery.nextCount(9000,8,1000));assertFalse(RenderRecovery.recent(9000,1000,60000));}

    private static final String VERSION = "114.0.5.302";
    private static final String REPORT = "2026-11-21 13:31:51 App=1.0.480，WebView=114.0.5.302，didCrash=true，priority=2，"
            + "可用内存=4713MB，lowMemory=false，JavaHeap=8/384MB，连续=1，软件绘制=false，HUAWEI ADY-AL00，"
            + "崩溃前界面=对话 · 已打开 1 分 10 秒 · 消息 4 条 · 动画 1 个 · 元素 3263 个 · 兼容显示开 · 最后操作：发消息（25 秒前）";

    @Test public void affectedProviderChangesPathOnlyAfterCrashingInSafeMode() {
        assertTrue(RenderRecovery.useSoftwareOnRecovery("huawei", VERSION, true, true, false));
        assertFalse(RenderRecovery.useSoftwareOnRecovery("HUAWEI", VERSION, false, true, false));
        assertFalse(RenderRecovery.useSoftwareOnRecovery("HUAWEI", VERSION, true, false, false));
        assertFalse(RenderRecovery.useSoftwareOnRecovery("HUAWEI", VERSION, true, true, true));
        assertFalse(RenderRecovery.useSoftwareOnRecovery("HUAWEI", "134.0", true, true, false));
        assertFalse(RenderRecovery.useSoftwareOnRecovery("other", VERSION, true, true, false));
        assertFalse(RenderRecovery.useSoftwareOnRecovery("HUAWEI", null, true, true, false));
    }

    @Test public void version480ReportCarriesRecoveryAcrossAppUpdate() {
        assertTrue(RenderRecovery.matchesPreviousCrash("HUAWEI", VERSION, REPORT));
        assertFalse(RenderRecovery.matchesPreviousCrash("HUAWEI", "114.0.5.303", REPORT));
        assertFalse(RenderRecovery.matchesPreviousCrash("other", VERSION, REPORT));
        assertFalse(RenderRecovery.matchesPreviousCrash("HUAWEI", VERSION, ""));
        for (String field : new String[]{"didCrash=true", "lowMemory=false", "软件绘制=false", "兼容显示开"}) {
            assertFalse(field, RenderRecovery.matchesPreviousCrash("HUAWEI", VERSION, REPORT.replace(field, "")));
        }
    }

    @Test public void manualChoiceRemainsAvailableAndAutomaticChoiceExpiresOnProviderUpdate() {
        assertTrue(RenderRecovery.useSavedSoftwareLayer(false, "Huawei", VERSION, VERSION));
        assertFalse(RenderRecovery.useSavedSoftwareLayer(false, "Huawei", VERSION, ""));
        assertFalse(RenderRecovery.useSavedSoftwareLayer(false, "Huawei", "114.0.5.303", VERSION));
        assertFalse(RenderRecovery.useSavedSoftwareLayer(false, "Huawei", null, VERSION));
        assertFalse(RenderRecovery.useSavedSoftwareLayer(false, "other", VERSION, VERSION));
        assertTrue(RenderRecovery.useSavedSoftwareLayer(true, "other", null, ""));
    }
}
