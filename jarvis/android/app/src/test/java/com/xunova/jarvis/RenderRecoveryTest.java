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
    @Test public void onlyForegroundHardwareCrashesOnTheAffectedProviderCount() {
        assertTrue(RenderRecovery.eligibleHardwareCrash("huawei", VERSION, true, false, false, true, false));
        assertFalse(RenderRecovery.eligibleHardwareCrash("HUAWEI", VERSION, false, false, false, true, false));
        assertFalse(RenderRecovery.eligibleHardwareCrash("HUAWEI", VERSION, true, true, false, true, false));
        assertFalse(RenderRecovery.eligibleHardwareCrash("HUAWEI", VERSION, true, false, true, true, false));
        assertFalse(RenderRecovery.eligibleHardwareCrash("HUAWEI", VERSION, true, false, false, false, false));
        assertFalse(RenderRecovery.eligibleHardwareCrash("HUAWEI", VERSION, true, false, false, true, true));
        assertFalse(RenderRecovery.eligibleHardwareCrash("HUAWEI", "134.0", true, false, false, true, false));
        assertFalse(RenderRecovery.eligibleHardwareCrash("other", VERSION, true, false, false, true, false));
        assertFalse(RenderRecovery.eligibleHardwareCrash("HUAWEI", null, true, false, false, true, false));
    }

    @Test public void singleOrLegacyCrashLeavesLightweightChatOnSystemDrawing() {
        long now = 90000;
        assertTrue(RenderRecovery.safeDisplayActive(false, now - 1, 0, now));
        // 480–485 的报告、旧内核号与 lastCrash 仍可用于诊断，但当时没有软件救援开始时间。
        assertFalse(RenderRecovery.softwareLayerNow(false, "HUAWEI", VERSION, VERSION, 0, now));
        assertFalse(RenderRecovery.repeatedHardwareCrash(VERSION, "", true, now - 1, now));
    }

    @Test public void onlyTwoConsecutiveHardwareCrashesWithinFiveMinutesActivateRescue() {
        long last = 1000, now = 2500;
        assertTrue(RenderRecovery.repeatedHardwareCrash(VERSION, VERSION, true, last, now));
        assertFalse(RenderRecovery.repeatedHardwareCrash(VERSION, VERSION, false, last, now));
        assertFalse(RenderRecovery.repeatedHardwareCrash("", VERSION, true, last, now));
        assertFalse(RenderRecovery.repeatedHardwareCrash("", "", true, last, now));
        assertFalse(RenderRecovery.repeatedHardwareCrash(VERSION, "114.0.5.303", true, last, now));
        assertFalse(RenderRecovery.repeatedHardwareCrash(VERSION, VERSION, true, last, last - 1));
        assertFalse(RenderRecovery.repeatedHardwareCrash(VERSION, VERSION, true, last, last + RenderRecovery.WINDOW_MS));
        assertFalse(RenderRecovery.repeatedHardwareCrash(VERSION, VERSION, true, 0, now));
    }

    @Test public void manualChoiceRemainsAvailableAndAutomaticChoiceExpiresOnProviderUpdate() {
        long last = 1000, now = 2500;
        assertTrue(RenderRecovery.softwareLayerNow(false, "Huawei", VERSION, VERSION, last, now));
        assertFalse(RenderRecovery.softwareLayerNow(false, "Huawei", VERSION, "", last, now));
        assertFalse(RenderRecovery.softwareLayerNow(false, "Huawei", "114.0.5.303", VERSION, last, now));
        assertFalse(RenderRecovery.softwareLayerNow(false, "Huawei", null, VERSION, last, now));
        assertFalse(RenderRecovery.softwareLayerNow(false, "other", VERSION, VERSION, last, now));
        assertTrue(RenderRecovery.softwareLayerNow(true, "other", null, "", 0, now));
    }

    // 2026-11-21 用户：手机特别卡。崩溃和内存提醒不能把兼容显示、软件绘制永久打开。
    private static final long DAY = 24 * 60 * 60 * 1000L;
    @Test public void crashAndMemoryProtectionExpire() {
        long now = 100 * DAY;
        assertTrue(RenderRecovery.safeDisplayActive(true, 0, 0, now));
        assertFalse(RenderRecovery.safeDisplayActive(false, 0, 0, now));
        assertTrue(RenderRecovery.safeDisplayActive(false, now - 2 * DAY, 0, now));
        assertFalse(RenderRecovery.safeDisplayActive(false, now - 3 * DAY, 0, now));
        assertTrue(RenderRecovery.safeDisplayActive(false, 0, now - 5 * 60 * 60 * 1000L, now));
        assertFalse(RenderRecovery.safeDisplayActive(false, 0, now - 7 * 60 * 60 * 1000L, now));
    }

    @Test public void automaticSoftwareDrawingStopsAfterFiveMinutesManualStays() {
        long now = 100 * DAY;
        assertTrue(RenderRecovery.softwareLayerNow(false, "HUAWEI", VERSION, VERSION, now - RenderRecovery.WINDOW_MS + 1, now));
        assertFalse(RenderRecovery.softwareLayerNow(false, "HUAWEI", VERSION, VERSION, now - RenderRecovery.WINDOW_MS, now));
        assertFalse(RenderRecovery.softwareLayerNow(false, "HUAWEI", VERSION, VERSION, now - DAY, now));
        assertFalse(RenderRecovery.softwareLayerNow(false, "HUAWEI", VERSION, VERSION, now + 1, now));
        assertFalse(RenderRecovery.softwareLayerNow(false, "HUAWEI", VERSION, VERSION, now - 3 * DAY, now));
        assertFalse(RenderRecovery.softwareLayerNow(false, "HUAWEI", VERSION, VERSION, 0, now));
        assertFalse(RenderRecovery.softwareLayerNow(false, "HUAWEI", VERSION, "", now - DAY, now));
        assertFalse(RenderRecovery.softwareLayerNow(false, "other", VERSION, VERSION, now - DAY, now));
        assertTrue(RenderRecovery.softwareLayerNow(true, "other", null, "", 0, now));
    }
}
