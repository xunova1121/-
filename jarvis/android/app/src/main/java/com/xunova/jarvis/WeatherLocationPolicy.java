package com.xunova.jarvis;

/** 单次粗略定位的新鲜度规则；单调时钟不受用户调时影响，不增加后台/精确定位权限。 */
final class WeatherLocationPolicy {
    static final long MAX_AGE_MS = 60000L;
    static long cacheAge(Object requested) {
        if (!(requested instanceof Number) || !Double.isFinite(((Number) requested).doubleValue())) return 30000L;
        return Math.max(0L, Math.min(MAX_AGE_MS, ((Number) requested).longValue()));
    }
    static boolean fresh(long fixNanos, long nowNanos, long ageMs) {
        return ageMs > 0L && fixNanos > 0L && nowNanos >= fixNanos
            && nowNanos - fixNanos <= ageMs * 1000000L;
    }
    static boolean canReplace(boolean newManualRequest) {
        return newManualRequest;
    }
}
