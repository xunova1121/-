package com.xunova.jarvis;

/** 分享只保留一个有期限的返回入口；晚到回调不能清掉或替换另一轮分享。 */
public final class ShareReturnController {
    public static final long TTL_MS = 30 * 60 * 1000L;
    private static final Object LOCK = new Object();

    public static final class State {
        public final String id;
        public final long startedAt;
        public State(String id, long startedAt) { this.id = id; this.startedAt = startedAt; }
    }

    public interface Store {
        State read();
        boolean write(State state);
        void clear();
    }

    public interface Notifications {
        boolean allowed();
        void show(long remainingMs);
        void cancel();
    }

    private final Store store;
    private final Notifications notifications;

    public ShareReturnController(Store store, Notifications notifications) {
        this.store = store;
        this.notifications = notifications;
    }

    public static boolean validId(String id) {
        return id != null && id.length() >= 1 && id.length() <= 80 && id.matches("[A-Za-z0-9_-]+");
    }

    public static long remaining(State state, long now) {
        if (state == null || !validId(state.id) || state.startedAt <= 0 || now < state.startedAt) return 0;
        long age = now - state.startedAt;
        return age >= TTL_MS ? 0 : TTL_MS - age;
    }

    /** Android 7 没有系统通知到期回收：不发可能在进程死亡后永久留下的通知。 */
    public static boolean supportsTimeout(int sdk) { return sdk >= 26; }

    public boolean prepare(String id, long now) {
        if (!validId(id) || now <= 0) throw new IllegalArgumentException("分享返回标识无效");
        synchronized (LOCK) {
            State previous = current(now);
            if (previous != null && !previous.id.equals(id)) return false;
            State active = previous != null ? previous : new State(id, now);
            if (previous == null && !store.write(active)) { cancel(); store.clear(); return false; }
            try {
                if (!notifications.allowed()) { cancel(); return false; }
                // 同一轮重复prepare使用剩余期限，不因插件重建或重试延长通知。
                notifications.show(remaining(active, now));
                return true;
            } catch (RuntimeException unavailable) {
                cancel();
                store.clear();
                return false;
            }
        }
    }

    public boolean finish(String id) {
        if (!validId(id)) throw new IllegalArgumentException("分享返回标识无效");
        synchronized (LOCK) {
            State active = store.read();
            if (active == null || !id.equals(active.id)) return false;
            cancel();
            store.clear();
            return true;
        }
    }

    /** load/resume只清理过期状态，不把普通返回前台误当微信已发送成功。 */
    public void expire(long now) { synchronized (LOCK) { current(now); } }

    private State current(long now) {
        State state = store.read();
        if (remaining(state, now) > 0) return state;
        cancel();
        store.clear();
        return null;
    }

    private void cancel() {
        try { notifications.cancel(); } catch (RuntimeException ignored) { /* 系统通知不可用仍清本机状态 */ }
    }
}
