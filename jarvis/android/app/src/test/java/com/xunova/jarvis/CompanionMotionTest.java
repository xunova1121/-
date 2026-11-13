package com.xunova.jarvis;
import org.junit.Test;
import static org.junit.Assert.*;
public class CompanionMotionTest {
    @Test public void hiddenWallpaperStopsFrames(){assertEquals(-1,CompanionMotion.frameDelay(false,false,0,true));}
    @Test public void idleAndSafeModesReduceFrames(){assertEquals(500,CompanionMotion.frameDelay(true,false,50000,false));assertEquals(250,CompanionMotion.frameDelay(true,true,0,true));assertEquals(66,CompanionMotion.frameDelay(true,false,0,true));}
    @Test public void onlyCharacterTapsRespond(){assertTrue(CompanionMotion.hit(100,100,100,100,80));assertFalse(CompanionMotion.hit(190,100,100,100,80));assertFalse(CompanionMotion.tap(10,10,100,100,2));assertTrue(CompanionMotion.tap(10,10,14,15,2));}
    @Test public void repeatedPettingHasDistinctPoses(){assertEquals(11,CompanionMotion.pose(1));assertEquals(6,CompanionMotion.pose(2));assertEquals(7,CompanionMotion.pose(3));}
}
