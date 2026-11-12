package com.xunova.jarvis;

import org.junit.Test;
import static org.junit.Assert.*;

public class ShareReturnControllerTest {
    private static class Memory implements ShareReturnController.Store {
        ShareReturnController.State state;
        boolean writable = true;
        public ShareReturnController.State read() { return state; }
        public boolean write(ShareReturnController.State next) { if (!writable) return false; state = next; return true; }
        public void clear() { state = null; }
    }
    private static class Notifications implements ShareReturnController.Notifications {
        boolean allowed = true, failShow = false, failCancel = false, visible = false;
        long timeout;
        int shows;
        public boolean allowed() { return allowed; }
        public void show(long remaining) { if (failShow) throw new SecurityException(); visible = true; timeout = remaining; shows++; }
        public void cancel() { if (failCancel) throw new SecurityException(); visible = false; }
    }

    @Test public void invalidIdsCannotChangeCurrentShare() {
        Memory store = new Memory(); Notifications notices = new Notifications();
        ShareReturnController controller = new ShareReturnController(store, notices);
        assertTrue(controller.prepare("share_A-1", 1000));
        String[] invalid = { null, "", "../file", "汉字", "with space", "x\n", new String(new char[81]).replace('\0', 'a') };
        for (String id : invalid) {
            try { controller.prepare(id, 1001); fail("invalid prepare"); } catch (IllegalArgumentException expected) { }
            try { controller.finish(id); fail("invalid finish"); } catch (IllegalArgumentException expected) { }
            assertEquals("share_A-1", store.state.id); assertTrue(notices.visible);
        }
    }

    @Test public void sameShareIsIdempotentAndCannotExtendDeadline() {
        Memory store = new Memory(); Notifications notices = new Notifications();
        ShareReturnController controller = new ShareReturnController(store, notices);
        assertTrue(controller.prepare("a", 1000));
        assertEquals(ShareReturnController.TTL_MS, notices.timeout);
        assertTrue(controller.prepare("a", 6000));
        assertEquals(1000, store.state.startedAt);
        assertEquals(ShareReturnController.TTL_MS - 5000, notices.timeout);
    }

    @Test public void anotherPrepareAndOldFinishCannotReplaceCurrentShare() {
        Memory store = new Memory(); Notifications notices = new Notifications();
        ShareReturnController controller = new ShareReturnController(store, notices);
        assertTrue(controller.prepare("old", 1000)); assertTrue(controller.finish("old"));
        assertTrue(controller.prepare("new", 2000));
        assertFalse(controller.prepare("old", 3000)); assertFalse(controller.finish("old"));
        assertEquals("new", store.state.id); assertEquals(2, notices.shows); assertTrue(notices.visible);
        assertTrue(controller.finish("new")); assertNull(store.state); assertFalse(notices.visible);
    }

    @Test public void processRecreationKeepsOnlyUnexpiredState() {
        Memory store = new Memory(); Notifications notices = new Notifications();
        new ShareReturnController(store, notices).prepare("a", 1000);
        ShareReturnController recreated = new ShareReturnController(store, notices);
        recreated.expire(2000); assertEquals("a", store.state.id); assertTrue(notices.visible);
        recreated.expire(1000 + ShareReturnController.TTL_MS); assertNull(store.state); assertFalse(notices.visible);
        assertTrue(recreated.prepare("b", 1001 + ShareReturnController.TTL_MS));
    }

    @Test public void futureClockAndCorruptStateAreDiscarded() {
        Memory store = new Memory(); Notifications notices = new Notifications();
        ShareReturnController controller = new ShareReturnController(store, notices);
        store.state = new ShareReturnController.State("a", 9000); controller.expire(1000); assertNull(store.state);
        store.state = new ShareReturnController.State("../private", 1000); controller.expire(1001); assertNull(store.state);
        store.state = new ShareReturnController.State("a", 0); controller.expire(1001); assertNull(store.state);
        assertEquals(0, ShareReturnController.remaining(new ShareReturnController.State("a", 1), Long.MAX_VALUE));
    }

    @Test public void permissionDeniedDoesNotPretendNotificationExists() {
        Memory store = new Memory(); Notifications notices = new Notifications(); notices.allowed = false;
        ShareReturnController controller = new ShareReturnController(store, notices);
        assertFalse(controller.prepare("a", 1000)); assertFalse(notices.visible); assertEquals(0, notices.shows);
        assertTrue(controller.finish("a")); assertNull(store.state);
        assertFalse(ShareReturnController.supportsTimeout(24)); assertFalse(ShareReturnController.supportsTimeout(25));
        assertTrue(ShareReturnController.supportsTimeout(26)); assertTrue(ShareReturnController.supportsTimeout(36));
    }

    @Test public void notificationFailureClearsStateAndAllowsNextShare() {
        Memory store = new Memory(); Notifications notices = new Notifications(); notices.failShow = true;
        ShareReturnController controller = new ShareReturnController(store, notices);
        assertFalse(controller.prepare("a", 1000)); assertNull(store.state); assertFalse(notices.visible);
        notices.failShow = false; assertTrue(controller.prepare("b", 2000)); assertEquals("b", store.state.id);
    }

    @Test public void storageFailureDoesNotLeaveAnUntrackedNotification() {
        Memory store = new Memory(); Notifications notices = new Notifications(); store.writable = false;
        assertFalse(new ShareReturnController(store, notices).prepare("a", 1000));
        assertNull(store.state); assertEquals(0, notices.shows); assertFalse(notices.visible);
    }

    @Test public void unavailableNotificationManagerStillClearsMatchingState() {
        Memory store = new Memory(); Notifications notices = new Notifications();
        ShareReturnController controller = new ShareReturnController(store, notices);
        assertTrue(controller.prepare("a", 1000)); notices.failCancel = true;
        assertTrue(controller.finish("a")); assertNull(store.state);
    }
}
