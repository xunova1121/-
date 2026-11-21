package com.xunova.jarvis;

/** 与 Android UI 无关的恢复决策：连续异常最多自动恢复一次。 */
public final class RenderRecovery {
    public static final long WINDOW_MS = 5 * 60 * 1000L;
    private RenderRecovery() { }
    public static int nextCount(long previousTime, int previousCount, long now) {
        return previousTime > 0 && now >= previousTime && now - previousTime < WINDOW_MS ? Math.max(0, previousCount) + 1 : 1;
    }
    public static boolean shouldReduceDisplay(int level){return level==15 || level>=60;}
    public static boolean autoRestart(int count) { return count == 1; }
    // 2026-11-21 用户：手机特别卡。原来崩过一次或系统提醒一次内存紧张，兼容显示就永久打开；
    // 华为 114 内核崩过还会一直用软件绘制（整个界面由处理器画），要等系统组件更新才解除。改成限时：
    // 崩溃后的兼容显示与自动软件绘制最多保持 3 天，内存紧张只临时开 6 小时；手动选择的不受限。
    public static final long CRASH_PROTECT_MS = 3 * 24 * 60 * 60 * 1000L;
    public static final long TRIM_PROTECT_MS = 6 * 60 * 60 * 1000L;
    public static boolean safeDisplayActive(boolean manual, long lastCrash, long lastTrim, long now) {
        return manual || recent(lastCrash, now, CRASH_PROTECT_MS) || recent(lastTrim, now, TRIM_PROTECT_MS);
    }
    /** 本次启动是否用软件绘制：手动选择一直有效；自动的只在最近一次崩溃后 3 天内有效。 */
    static boolean softwareLayerNow(boolean manual, String manufacturer, String version, String recoveryVersion, long lastCrash, long now) {
        return manual || (useSavedSoftwareLayer(false, manufacturer, version, recoveryVersion) && recent(lastCrash, now, CRASH_PROTECT_MS));
    }
    public static boolean recent(long previousTime, long now, long window) {
        return previousTime > 0 && now >= previousTime && now - previousTime < window;
    }

    // 华为 114 内核已有兼容显示下的渲染器崩溃报告。只对同一内核尝试替代绘制路径。
    private static boolean affectedProvider(String manufacturer, String version) {
        return "HUAWEI".equalsIgnoreCase(manufacturer) && version != null && version.startsWith("114.");
    }

    static boolean useSavedSoftwareLayer(boolean manual, String manufacturer, String version, String recoveryVersion) {
        return manual || (affectedProvider(manufacturer, version) && version.equals(recoveryVersion));
    }

    static boolean useSoftwareOnRecovery(String manufacturer, String version, boolean wasSafe,
                                         boolean didCrash, boolean lowMemory) {
        return wasSafe && didCrash && !lowMemory && affectedProvider(manufacturer, version);
    }

    // 1.0.480 只保存了上一次原生报告。升级后可以直接承接相同故障，不要求再崩一次。
    static boolean matchesPreviousCrash(String manufacturer, String version, String report) {
        if (!useSoftwareOnRecovery(manufacturer, version, true, true, false) || report == null) return false;
        return report.contains("，WebView=" + version + "，didCrash=true，")
                && report.contains("，lowMemory=false，") && report.contains("，软件绘制=false，")
                && report.contains("兼容显示开");
    }
}
