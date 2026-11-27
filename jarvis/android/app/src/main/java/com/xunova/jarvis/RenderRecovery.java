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
    // 限制页面特效可以保留较久；整窗软件绘制单独判断。
    public static final long CRASH_PROTECT_MS = 3 * 24 * 60 * 60 * 1000L;
    public static final long TRIM_PROTECT_MS = 6 * 60 * 60 * 1000L;
    public static boolean safeDisplayActive(boolean manual, long lastCrash, long lastTrim, long now) {
        return manual || recent(lastCrash, now, CRASH_PROTECT_MS) || recent(lastTrim, now, TRIM_PROTECT_MS);
    }
    /** 自动软件绘制只认已经确认的连续硬件绘制崩溃，单次崩溃或旧恢复版本号不能开启它。 */
    static boolean softwareLayerNow(boolean manual, String manufacturer, String version, String crashVersion, long rescueStarted, long now) {
        return manual || (affectedProvider(manufacturer, version) && version.equals(crashVersion) && recent(rescueStarted, now, WINDOW_MS));
    }
    public static boolean recent(long previousTime, long now, long window) {
        return previousTime > 0 && now >= previousTime && now - previousTime < window;
    }

    // 华为 114 内核已有兼容显示下的渲染器崩溃报告。只对同一内核尝试替代绘制路径。
    private static boolean affectedProvider(String manufacturer, String version) {
        return "HUAWEI".equalsIgnoreCase(manufacturer) && version != null && version.startsWith("114.");
    }

    static boolean eligibleHardwareCrash(String manufacturer, String version, boolean foreground,
                                        boolean room, boolean software, boolean didCrash, boolean lowMemory) {
        return affectedProvider(manufacturer, version) && foreground && !room && !software && didCrash && !lowMemory;
    }

    // 两次相邻故障均须符合条件，第二次发生时已经在用兼容显示。
    static boolean repeatedHardwareCrash(String currentCrashVersion, String previousCrashVersion,
                                         boolean wasSafe, long previousCrash, long now) {
        return wasSafe && !currentCrashVersion.isEmpty() && currentCrashVersion.equals(previousCrashVersion)
                && recent(previousCrash, now, WINDOW_MS);
    }
}
