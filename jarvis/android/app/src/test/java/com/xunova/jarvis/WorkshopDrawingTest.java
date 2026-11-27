package com.xunova.jarvis;

import org.junit.Test;
import static org.junit.Assert.*;

public class WorkshopDrawingTest {
    @Test public void foregroundBorrowsAndReturnsOnlyAnExistingSoftwareLayer() {
        for (boolean originallySoftware : new boolean[]{true, false}) {
            WorkshopDrawing room = new WorkshopDrawing();
            assertTrue(room.request(true, 11));
            assertFalse(room.softwareFor(true, originallySoftware));
            assertTrue(room.active());
            assertTrue(room.request(true, 11));
            assertFalse(room.softwareFor(true, false));
            assertTrue(room.request(false, 12));
            assertEquals(originallySoftware, room.softwareFor(true, false));
            assertFalse(room.active());
        }
    }

    @Test public void oldOrConflictingRequestsCannotReopenRoom() {
        WorkshopDrawing room = new WorkshopDrawing();
        assertTrue(room.request(false, 20));
        assertFalse(room.request(true, 19));
        assertFalse(room.request(true, 20));
        assertTrue(room.request(false, 20));
        assertFalse(room.requested());
    }

    @Test public void navigationDropsQueuedRequestsAndRestoresChat() {
        WorkshopDrawing room = new WorkshopDrawing();
        room.request(true, 18);
        assertFalse(room.softwareFor(true, true));
        room.documentStarted(25);
        assertFalse(room.request(true, 23));
        assertTrue(room.softwareFor(true, false));
        assertFalse(room.active());
        assertTrue(room.request(true, 25));
    }

    @Test public void backgroundOrCrashCooldownSuspendsDrawingUntilAllowed() {
        WorkshopDrawing room = new WorkshopDrawing();
        room.request(true, 10);
        assertTrue(room.softwareFor(false, true));
        assertFalse(room.active());
        assertFalse(room.softwareFor(true, true));
        assertTrue(room.softwareFor(false, false));
        assertTrue(room.requested());
        assertFalse(room.active());
        assertFalse(room.softwareFor(true, true));
        room.request(false, 11);
        assertTrue(room.softwareFor(false, false));
        assertTrue(room.softwareFor(true, true));
    }

    @Test public void userCanTurnOffSoftwareRecoveryInsideRoom() {
        WorkshopDrawing room = new WorkshopDrawing();
        room.request(true, 1);
        assertFalse(room.softwareFor(true, true));
        room.userChoseDefault();
        room.request(false, 2);
        assertFalse(room.softwareFor(true, false));
    }

    @Test public void crashCooldownExpiresAndAppliesOnlyToTheSameWebView() {
        String version = "114.0.5.302";
        assertTrue(WorkshopDrawing.coolingDown(10, 11, version, version));
        assertFalse(WorkshopDrawing.coolingDown(10, 11, version, "114.0.5.303"));
        assertFalse(WorkshopDrawing.coolingDown(10, 10 + RenderRecovery.WINDOW_MS, version, version));
        assertFalse(WorkshopDrawing.coolingDown(10, 9, version, version));
        assertFalse(WorkshopDrawing.coolingDown(0, 100, version, version));
    }
}
