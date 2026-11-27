package com.xunova.jarvis;

import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;
import android.util.DisplayMetrics;
import com.getcapacitor.JSObject;
import com.getcapacitor.JSArray;
import java.util.LinkedHashMap;
import java.util.UUID;

/** 节点句柄仅在手机内存；每次读屏销毁旧句柄，操作前再刷新并校验。 */
final class PhoneScreen {
    private final LinkedHashMap<String, AccessibilityNodeInfo> nodes = new LinkedHashMap<>();
    private final LinkedHashMap<String, String> fingerprints = new LinkedHashMap<>();
    String id = "", packageName = "";
    long revision;
    int width, height, visited;
    boolean truncated;
    final Rect appBounds = new Rect();
    final java.util.ArrayList<Rect> redactions = new java.util.ArrayList<>();
    void clear() { for (AccessibilityNodeInfo n : nodes.values()) n.recycle(); nodes.clear(); fingerprints.clear(); id = ""; }
    static String chars(CharSequence value) { String s = value == null ? "" : value.toString(); return s.substring(0, Math.min(160, s.length())); }
    static String fingerprint(AccessibilityNodeInfo n) { Rect b = new Rect(); n.getBoundsInScreen(b); return chars(n.getPackageName()) + "|" + chars(n.getText()) + "|" + chars(n.getContentDescription()) + "|" + b.flattenToString(); }
    JSObject read(PhoneAccessibilityService service) throws Exception {
        clear(); redactions.clear(); AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null) throw new Exception("PHONE_NO_SCREEN");
        try {
            packageName = chars(root.getPackageName()); service.requireApp(packageName);
            if (packageName.equals(service.getPackageName())) throw new Exception("PHONE_APP_DENIED");
            root.getBoundsInScreen(appBounds);
            DisplayMetrics dm = new DisplayMetrics(); ((android.view.WindowManager)service.getSystemService(android.content.Context.WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(dm); width = dm.widthPixels; height = dm.heightPixels;
            id = UUID.randomUUID().toString(); revision = service.revision; visited = 0; truncated = false;
            JSArray rows = new JSArray(); walk(root, rows, 0, false);
            JSObject out = new JSObject(); out.put("snapshotId", id); out.put("packageName", packageName); out.put("width", width); out.put("height", height); out.put("nodes", rows); out.put("truncated", truncated); return out;
        } finally { root.recycle(); }
    }
    private void walk(AccessibilityNodeInfo n, JSArray rows, int depth, boolean hidden) {
        if (depth > 24 || ++visited > 500 || nodes.size() >= PhonePolicy.MAX_NODES) { truncated = true; return; }
        boolean secret = hidden || n.isPassword() || PhonePolicy.privateField(chars(n.getContentDescription()) + " " + (android.os.Build.VERSION.SDK_INT >= 26 ? chars(n.getHintText()) : ""));
        if (secret) { Rect r = new Rect(); n.getBoundsInScreen(r); redactions.add(r); return; }
        String text = chars(n.getText()), desc = chars(n.getContentDescription());
        if (n.isVisibleToUser() && (!text.isEmpty() || !desc.isEmpty() || n.isClickable() || n.isEditable())) {
            String key = "n" + nodes.size(); nodes.put(key, AccessibilityNodeInfo.obtain(n)); fingerprints.put(key, fingerprint(n));
            Rect rect = new Rect(); n.getBoundsInScreen(rect);
            JSObject row = new JSObject(); row.put("id", key); row.put("text", text); row.put("description", desc); row.put("clickable", n.isClickable()); row.put("editable", n.isEditable());
            JSArray bounds = new JSArray(); bounds.put(rect.left); bounds.put(rect.top); bounds.put(rect.right); bounds.put(rect.bottom); row.put("bounds", bounds); rows.put(row);
        }
        if (n.getChildCount() > 80) truncated = true;
        for (int i = 0; i < Math.min(80, n.getChildCount()); i++) { AccessibilityNodeInfo child = n.getChild(i); if (child != null) { try { walk(child, rows, depth + 1, secret); } finally { child.recycle(); } } }
    }
    void validate(PhoneAccessibilityService service, String snapshot) throws Exception {
        if (id.isEmpty() || !id.equals(snapshot) || revision != service.revision) throw new Exception("PHONE_STALE_SCREEN");
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        try { if (root == null || !packageName.equals(chars(root.getPackageName()))) throw new Exception("PHONE_STALE_SCREEN"); service.requireApp(packageName); }
        finally { if (root != null) root.recycle(); }
    }
    AccessibilityNodeInfo node(String key) throws Exception {
        AccessibilityNodeInfo n = nodes.get(key);
        if (n == null || !n.refresh() || !n.isVisibleToUser() || !n.isEnabled() || n.isPassword() || !fingerprints.get(key).equals(fingerprint(n))) throw new Exception("PHONE_STALE_SCREEN");
        return n;
    }
}
