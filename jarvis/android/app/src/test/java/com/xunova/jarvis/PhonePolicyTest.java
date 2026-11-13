package com.xunova.jarvis;
import org.junit.Test;
import static org.junit.Assert.*;

public class PhonePolicyTest {
    @Test public void sensitiveAndUnknownClicksRequirePerson() {
        for (String label : new String[]{"发送", "支付100元", "Delete", "确认", "🔴", "联系人 张三"}) assertTrue(label, PhonePolicy.confirmation("tap", label, false));
        assertFalse(PhonePolicy.confirmation("tap", "返回", false));
        assertTrue(PhonePolicy.confirmation("tap", "返回", true));
        assertTrue(PhonePolicy.confirmation("share_text", "", false));
        assertTrue(PhonePolicy.confirmation("alarm", "", false));
    }
    @Test public void authorizationExpiresAndLockStops() {
        assertTrue(PhonePolicy.active(100, 99, false, false));
        assertFalse(PhonePolicy.active(100, 100, false, false));
        assertFalse(PhonePolicy.active(100, 99, true, false));
        assertFalse(PhonePolicy.active(100, 99, false, true));
    }
    @Test public void noArbitraryIntentOrNonFiniteCoordinates() {
        assertTrue(PhonePolicy.validPackage("com.tencent.mm"));
        assertFalse(PhonePolicy.validPackage("intent://open"));
        assertFalse(PhonePolicy.ratio(Double.NaN)); assertFalse(PhonePolicy.ratio(1.1)); assertFalse(PhonePolicy.ratio(-.1)); assertTrue(PhonePolicy.ratio(.5));
    }
    @Test public void passwordsAndCodesAreManual() {
        for (String hint : new String[]{"请输入密码", "短信验证码", "Password", "API key"}) assertTrue(PhonePolicy.privateField(hint));
        assertFalse(PhonePolicy.privateField("搜索联系人"));
    }
    @Test public void deviceTokenOnlyOverTlsOrLocalDevelopment() {
        assertTrue(PhonePolicy.secureTransport("https", "example.com"));
        assertTrue(PhonePolicy.secureTransport("http", "127.0.0.1"));
        assertFalse(PhonePolicy.secureTransport("http", "public.example.com"));
        assertFalse(PhonePolicy.secureTransport("file", "localhost"));
    }
}
