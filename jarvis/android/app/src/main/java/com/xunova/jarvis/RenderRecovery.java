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
}
