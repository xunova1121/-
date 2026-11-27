package com.xunova.jarvis;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.HashSet;
import java.util.Set;
import org.junit.Test;

public class ShareIntakePolicyTest {
    @Test public void 文件名只留名字本身并去掉怪字符() {
        assertEquals("合同.pdf", ShareIntakePolicy.safeName("/sdcard/Download/合同.pdf", 0));
        assertEquals("a_b.txt", ShareIntakePolicy.safeName("..\\..\\a:b.txt", 0));
        assertEquals("hidden", ShareIntakePolicy.safeName("...hidden", 0));
        assertEquals("分享的文件3", ShareIntakePolicy.safeName("", 2));
        assertEquals("分享的文件1", ShareIntakePolicy.safeName(null, 0));
        assertEquals("x_y", ShareIntakePolicy.safeName("x\u0000y", 0));
    }

    @Test public void 太长的文件名截短但保留扩展名() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 300; i++) sb.append('长');
        String name = ShareIntakePolicy.safeName(sb + ".docx", 0);
        assertEquals(120, name.length());
        assertTrue(name.endsWith(".docx"));
    }

    @Test public void 同一批重名加序号() {
        Set<String> used = new HashSet<>();
        assertEquals("图.jpg", ShareIntakePolicy.unique("图.jpg", used));
        assertEquals("图(2).jpg", ShareIntakePolicy.unique("图.jpg", used));
        assertEquals("图(3).jpg", ShareIntakePolicy.unique("图.jpg", used));
        assertEquals("说明", ShareIntakePolicy.unique("说明", used));
        assertEquals("说明(2)", ShareIntakePolicy.unique("说明", used));
    }

    @Test public void 个数和大小都有上限() {
        long mb = 1024L * 1024;
        assertTrue(ShareIntakePolicy.accept(0, 32 * mb, 0));
        assertFalse("单个超过 32MB", ShareIntakePolicy.accept(0, 32 * mb + 1, 0));
        assertFalse("合计超过 64MB", ShareIntakePolicy.accept(2, 10 * mb, 60 * mb));
        assertFalse("第 11 个", ShareIntakePolicy.accept(10, 1, 0));
        assertFalse(ShareIntakePolicy.accept(0, -1, 0));
    }

    @Test public void 缓存超过一天算过期() {
        long day = 24L * 60 * 60 * 1000;
        assertFalse(ShareIntakePolicy.expired(1000, 1000 + day));
        assertTrue(ShareIntakePolicy.expired(1000, 1001 + day));
    }

    @Test public void 文字去空白并限长() {
        assertNull(ShareIntakePolicy.clipText("   "));
        assertNull(ShareIntakePolicy.clipText(null));
        assertEquals("你好", ShareIntakePolicy.clipText("  你好 \n"));
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 30000; i++) sb.append('字');
        assertEquals(20000, ShareIntakePolicy.clipText(sb.toString()).length());
    }

    @Test public void 批次编号只认字母数字() {
        assertTrue(ShareIntakePolicy.validId("a1B2c3D4"));
        assertFalse(ShareIntakePolicy.validId("../etc"));
        assertFalse(ShareIntakePolicy.validId("abc"));
        assertFalse(ShareIntakePolicy.validId(null));
    }
}
