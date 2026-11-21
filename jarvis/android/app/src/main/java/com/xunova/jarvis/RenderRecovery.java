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
