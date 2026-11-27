package com.xunova.jarvis;

import android.graphics.Color;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** 无障碍自带的可见控制条；停止和确认始终由人点击，网页/模型无确认接口。 */
final class PhoneOverlay {
    private final PhoneAccessibilityService service;
    private LinearLayout box;
    PhoneOverlay(PhoneAccessibilityService service) { this.service = service; }
    void hide() { if (box != null) { try { ((WindowManager)service.getSystemService(android.content.Context.WINDOW_SERVICE)).removeView(box); } catch (IllegalArgumentException ignored) {} box = null; } }
    void show(String detail, Runnable approve) {
        hide(); box = new LinearLayout(service); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(12, 8, 12, 8); box.setBackgroundColor(Color.rgb(239, 245, 255));
        TextView title = new TextView(service); title.setTextColor(Color.rgb(25, 45, 80)); title.setTextSize(14); title.setMaxLines(8); title.setText(detail); box.addView(title);
        LinearLayout buttons = new LinearLayout(service);
        if (approve != null) button(buttons, "确认这一步", approve);
        else button(buttons, service.paused ? "恢复" : "暂停", () -> service.pause(!service.paused));
        button(buttons, "停止", service::stop); box.addView(buttons);
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(Math.min(service.getResources().getDisplayMetrics().widthPixels - 24, 680), WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, android.graphics.PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.END; params.y = 40;
        ((WindowManager)service.getSystemService(android.content.Context.WINDOW_SERVICE)).addView(box, params);
    }
    private void button(LinearLayout parent, String label, Runnable run) { Button b = new Button(service); b.setText(label); b.setMinHeight((int)(48 * service.getResources().getDisplayMetrics().density)); b.setOnClickListener(v -> run.run()); parent.addView(b, new LinearLayout.LayoutParams(0, -2, 1)); }
}
