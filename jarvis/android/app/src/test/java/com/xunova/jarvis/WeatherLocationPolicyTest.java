package com.xunova.jarvis;
import org.junit.Test;
import static org.junit.Assert.*;
public class WeatherLocationPolicyTest {
    @Test public void manualRequestsNeverReuseCache() {
        assertEquals(0L, WeatherLocationPolicy.cacheAge(0L));
        assertEquals(0L, WeatherLocationPolicy.cacheAge(0));
        assertEquals(30000L, WeatherLocationPolicy.cacheAge(Double.NaN));
        assertFalse(WeatherLocationPolicy.fresh(1000000000L,1000000001L,0L));
    }
    @Test public void tenMinuteOldAndFutureFixesAreRejected() {
        assertFalse(WeatherLocationPolicy.fresh(1000000000L,601000000000L,WeatherLocationPolicy.MAX_AGE_MS));
        assertFalse(WeatherLocationPolicy.fresh(2000000000L,1000000000L,30000L));
        assertTrue(WeatherLocationPolicy.fresh(1000000000L,2000000000L,30000L));
    }
    @Test public void cacheBudgetIsBoundedAndManualIntentWins() {
        assertEquals(60000L, WeatherLocationPolicy.cacheAge(600000L));
        assertEquals(0L, WeatherLocationPolicy.cacheAge(-1L));
        assertFalse(WeatherLocationPolicy.canReplace(false));
        assertTrue(WeatherLocationPolicy.canReplace(true));
    }
}
