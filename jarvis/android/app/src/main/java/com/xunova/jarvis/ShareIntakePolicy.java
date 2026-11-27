package com.xunova.jarvis;

/**
 * “分享 → 未央”的规则（纯逻辑，便于单测）：收多少、文件名怎么清理、缓存留多久。
 * 上限：一次最多 10 个文件；单个 32MB；一次合计 64MB；缓存最多留 24 小时；网页还没来取时最多攒 3 批。
 */
final class ShareIntakePolicy {
    static final int MAX_FILES = 10;
    static final long MAX_FILE = 32L * 1024 * 1024;
    static final long MAX_TOTAL = 64L * 1024 * 1024;
    static final long KEEP_MS = 24L * 60 * 60 * 1000;
    static final int MAX_PENDING = 3;
    static final int MAX_TEXT = 20000;
    private static final int MAX_NAME = 120;

    private ShareIntakePolicy() {}

    /** 只留文件名本身（去掉路径），去掉系统不认的字符和控制字符；空了就用“分享的文件N” */
    static String safeName(String raw, int index) {
        String name = raw == null ? "" : raw;
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (slash >= 0) name = name.substring(slash + 1);
        name = name.replaceAll("[\\u0000-\\u001f\\u007f:*?\"<>|]", "_").trim();
        while (name.startsWith(".")) name = name.substring(1);
        if (name.isEmpty()) name = "分享的文件" + (index + 1);
        if (name.length() > MAX_NAME) {
            int dot = name.lastIndexOf('.');
            String ext = dot > 0 && name.length() - dot <= 10 ? name.substring(dot) : "";
            name = name.substring(0, MAX_NAME - ext.length()) + ext;
        }
        return name;
    }

    /** 同一批里重名的加序号：a.jpg、a(2).jpg */
    static String unique(String name, java.util.Set<String> used) {
        if (used.add(name)) return name;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 2; ; i++) {
            String next = stem + "(" + i + ")" + ext;
            if (used.add(next)) return next;
        }
    }

    /** 这个文件还能不能收：个数、单个大小、合计大小都不超 */
    static boolean accept(int countSoFar, long size, long totalSoFar) {
        return countSoFar < MAX_FILES && size >= 0 && size <= MAX_FILE && totalSoFar + size <= MAX_TOTAL;
    }

    static boolean expired(long modifiedAt, long now) {
        return now - modifiedAt > KEEP_MS;
    }

    static String clipText(String text) {
        if (text == null) return null;
        String t = text.trim();
        if (t.isEmpty()) return null;
        return t.length() > MAX_TEXT ? t.substring(0, MAX_TEXT) : t;
    }

    /** 批次编号只许字母数字（网页回传 done 时用来删目录，防止路径穿越） */
    static boolean validId(String id) {
        return id != null && id.matches("[A-Za-z0-9]{8,40}");
    }
}
