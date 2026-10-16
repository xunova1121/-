package com.xunova.jarvis;
import org.junit.Test;
import static org.junit.Assert.*;
public class RenderRecoveryTest {
    @Test public void firstCrashRecoversOnce(){int n=RenderRecovery.nextCount(0,0,1000);assertEquals(1,n);assertTrue(RenderRecovery.autoRestart(n));}
    @Test public void repeatedCrashDoesNotLoop(){int n=RenderRecovery.nextCount(1000,1,2000);assertEquals(2,n);assertFalse(RenderRecovery.autoRestart(n));assertFalse(RenderRecovery.autoRestart(100));}
    @Test public void stableWindowStartsNewAttempt(){assertEquals(1,RenderRecovery.nextCount(1000,7,1000+RenderRecovery.WINDOW_MS));}
    @Test public void changedClockDoesNotReuseStreak(){assertEquals(1,RenderRecovery.nextCount(9000,8,1000));assertFalse(RenderRecovery.recent(9000,1000,60000));}
}
