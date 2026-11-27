package com.xunova.jarvis;

/** 小屋只在前台借用系统视频合成，聊天原先的软件图层在离开时归还。仅由 UI 线程操作。 */
final class WorkshopDrawing {
    private long lastRevision = -1;
    private boolean requested;
    // 设置页从诊断桥读取此状态，其他读写均在 UI 线程。
    private volatile boolean active;
    private boolean returnToSoftware;

    boolean request(boolean visible, long revision) {
        if (revision < lastRevision || (revision == lastRevision && requested != visible)) return false;
        lastRevision = revision;
        requested = visible;
        return true;
    }

    void documentStarted(long now) {
        // 页面导航前已发出、仍在桥接队列中的请求不能给新页面开启小屋。
        lastRevision = Math.max(lastRevision, now - 1);
        requested = false;
    }

    boolean requested() { return requested; }
    boolean active() { return active; }

    static boolean coolingDown(long previousCrash, long now, String previousVersion, String currentVersion) {
        return RenderRecovery.recent(previousCrash, now, RenderRecovery.WINDOW_MS) && currentVersion.equals(previousVersion);
    }

    boolean softwareFor(boolean allowed, boolean currentlySoftware) {
        active = requested && allowed;
        if (active && currentlySoftware) {
            returnToSoftware = true;
            return false;
        }
        if (!active && returnToSoftware) {
            returnToSoftware = false;
            return true;
        }
        return currentlySoftware;
    }

    void userChoseDefault() {
        returnToSoftware = false;
    }
}
