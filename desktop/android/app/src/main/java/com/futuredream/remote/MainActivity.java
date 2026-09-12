package com.futuredream.remote;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 未来创梦 · 安卓遥控端。
 *
 * ── 为什么需要这个壳，而不是让人在浏览器里开 ──
 *
 * 界面本身就是网页（ui/m/），浏览器里打开功能一模一样。做成 apk 是为了三件
 * 浏览器在**局域网 HTTP** 下做不到的事：
 *
 *   ① 真正的应用图标和独立窗口。安卓 Chrome 的「安装应用」（WebAPK）要求
 *      安全上下文，而 http://192.168.x.x 不是 —— 实测 isSecureContext=false，
 *      连 navigator.serviceWorker 都不存在。所以在浏览器里只能得到一个
 *      开在标签页里的书签，不是应用。
 *   ② 下载走系统下载器，文件落进「下载」目录，能直接分享给剪映。
 *   ③ 后台常驻不被浏览器随手回收 —— 一步跑十几分钟，切出去回来还在。
 *
 * 壳子刻意做得极薄：一个 WebView，一屏配置。所有逻辑都在网页那边，
 * 改功能不用重新发包。
 */
public class MainActivity extends Activity {

  private static final String PREFS = "fd";
  private static final String KEY_HOST = "host";
  private static final String KEY_CODE = "code";

  private WebView web;

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    String host = sp.getString(KEY_HOST, "");
    String code = sp.getString(KEY_CODE, "");
    if (host.isEmpty()) {
      showSetup(host, code);
    } else {
      showWeb(buildUrl(host, code));
    }
  }

  /** 电脑上「设置 → 手机遥控」显示的那两样：地址和配对码 */
  private String buildUrl(String host, String code) {
    String base = host.trim();
    if (!base.startsWith("http://") && !base.startsWith("https://")) base = "http://" + base;
    while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
    // 地址栏里可能已经带了 /m，别拼两遍
    if (!base.endsWith("/m")) base = base + "/m";
    return code.trim().isEmpty() ? base : base + "?k=" + Uri.encode(code.trim().toUpperCase());
  }

  /**
   * 配置屏。用代码搭而不是写 XML 布局：这一屏只有三个控件，
   * 为它多维护一套 layout 文件不划算。
   */
  private void showSetup(String host, String code) {
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setBackgroundColor(Color.parseColor("#16130f"));
    int pad = dp(22);
    root.setPadding(pad, dp(64), pad, pad);

    TextView title = new TextView(this);
    title.setText("连接到你的电脑");
    title.setTextColor(Color.parseColor("#f2ece3"));
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 21);
    root.addView(title);

    TextView hint = new TextView(this);
    hint.setText("电脑上打开「设置 → 手机遥控」，把那里显示的地址和 8 位配对码填进来。"
        + "手机要和电脑在同一个 Wi-Fi。");
    hint.setTextColor(Color.parseColor("#7d7365"));
    hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
    hint.setPadding(0, dp(8), 0, dp(20));
    root.addView(hint);

    final EditText hostInput = field("192.168.1.7:5179", host);
    hostInput.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
    root.addView(hostInput);

    final EditText codeInput = field("ABCD2345", code);
    codeInput.setInputType(InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS);
    ((LinearLayout.LayoutParams) codeInput.getLayoutParams()).topMargin = dp(12);
    root.addView(codeInput);

    Button go = new Button(this);
    go.setText("连接");
    go.setAllCaps(false);
    go.setBackgroundColor(Color.parseColor("#e8b45f"));
    go.setTextColor(Color.parseColor("#241b0c"));
    LinearLayout.LayoutParams gp = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
    gp.topMargin = dp(20);
    go.setLayoutParams(gp);
    go.setOnClickListener(v -> {
      String h = hostInput.getText().toString().trim();
      if (h.isEmpty()) {
        Toast.makeText(this, "先把地址填上", Toast.LENGTH_SHORT).show();
        return;
      }
      getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
          .putString(KEY_HOST, h)
          .putString(KEY_CODE, codeInput.getText().toString().trim())
          .apply();
      showWeb(buildUrl(h, codeInput.getText().toString()));
    });
    root.addView(go);

    TextView tip = new TextView(this);
    tip.setText("连不上就检查三件事：电脑上的「手机遥控」开关是开着的；两台设备在同一个 Wi-Fi；"
        + "地址里的 IP 和电脑上显示的一致。\n\n引擎始终在电脑上 —— 这个应用只是遥控器和播放器，"
        + "密钥不会存到手机里。");
    tip.setTextColor(Color.parseColor("#7d7365"));
    tip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
    tip.setPadding(0, dp(24), 0, 0);
    root.addView(tip);

    setContentView(root);
  }

  private EditText field(String hintText, String value) {
    EditText e = new EditText(this);
    e.setHint(hintText);
    e.setText(value);
    e.setSingleLine(true);
    e.setTextColor(Color.parseColor("#f2ece3"));
    e.setHintTextColor(Color.parseColor("#7d7365"));
    e.setBackgroundColor(Color.parseColor("#272119"));
    e.setPadding(dp(14), dp(14), dp(14), dp(14));
    e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
    e.setLayoutParams(new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    return e;
  }

  private void showWeb(String url) {
    web = new WebView(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true); // 配对码和当前项目存在 localStorage 里
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setUseWideViewPort(true);
    s.setLoadWithOverviewMode(true);
    s.setSupportZoom(false);
    web.setBackgroundColor(Color.parseColor("#16130f"));

    web.setWebViewClient(new WebViewClient() {
      @Override
      public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
        // 连不上时给一句能照着做的话，而不是安卓自带的那张"网页无法打开"
        if (req.isForMainFrame()) {
          view.loadDataWithBaseURL(null,
              "<html><body style='background:#16130f;color:#b6ab9b;font:15px/1.7 sans-serif;padding:48px 24px'>"
                  + "<h3 style='color:#f2ece3'>连不上电脑</h3>"
                  + "<p>检查三件事：电脑上的「设置 → 手机遥控」开关是开着的；两台设备在同一个 Wi-Fi；"
                  + "地址里的 IP 和电脑上显示的一致（换了 Wi-Fi 之后 IP 常常会变）。</p>"
                  + "<p style='color:#7d7365'>按两次返回键可以回到配置屏重填地址。</p>"
                  + "</body></html>",
              "text/html", "utf-8", null);
        }
      }
    });
    web.setWebChromeClient(new WebChromeClient());

    /**
     * 下载交给系统下载器。
     *
     * 这正是套壳的意义之一：素材包（成片 + 每镜片段 + 字幕 + 配音）动辄几百 MB，
     * 交给 DownloadManager 才有断点、有通知栏进度、下完落进「下载」目录 ——
     * 在那儿才能分享给剪映。
     */
    web.setDownloadListener((dlUrl, userAgent, contentDisposition, mimeType, size) -> {
      try {
        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(dlUrl));
        req.setMimeType(mimeType);
        req.allowScanningByMediaScanner();
        req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        String name = URLUtilName(dlUrl, contentDisposition, mimeType);
        req.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, name);
        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        dm.enqueue(req);
        Toast.makeText(this, "正在下载：" + name, Toast.LENGTH_SHORT).show();
      } catch (Exception e) {
        Toast.makeText(this, "下载没能开始：" + e.getMessage(), Toast.LENGTH_LONG).show();
      }
    });

    setContentView(web);
    web.loadUrl(url);
  }

  private String URLUtilName(String url, String disposition, String mime) {
    String guessed = android.webkit.URLUtil.guessFileName(url, disposition, mime);
    return guessed == null || guessed.isEmpty() ? "futuredream-download" : guessed;
  }

  private long lastBack = 0;

  /**
   * 返回键：先在网页里后退；已经在首页时，连按两次回到配置屏。
   * 换个 Wi-Fi、IP 变了是常事，得有一条不卸载重装就能改地址的路。
   */
  @Override
  public boolean onKeyDown(int code, KeyEvent event) {
    if (code == KeyEvent.KEYCODE_BACK && web != null) {
      if (web.canGoBack()) {
        web.goBack();
        return true;
      }
      long now = System.currentTimeMillis();
      if (now - lastBack < 1600) {
        SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        showSetup(sp.getString(KEY_HOST, ""), sp.getString(KEY_CODE, ""));
        web = null;
        return true;
      }
      lastBack = now;
      Toast.makeText(this, "再按一次返回，可以重填电脑地址", Toast.LENGTH_SHORT).show();
      return true;
    }
    return super.onKeyDown(code, event);
  }

  private int dp(int v) {
    return Math.round(TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
  }
}
