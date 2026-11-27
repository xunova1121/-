package com.xunova.jarvis;

import java.util.Locale;
import java.util.regex.Pattern;

/** 与页面提示无关的原生规则；服务器/模型不能传confirmed=true跳过手机确认。 */
public final class PhonePolicy {
    public static final long SESSION_MS = 15 * 60 * 1000L;
    public static final int MAX_NODES = 160;
    private static final Pattern SENSITIVE = Pattern.compile("发送|支付|付款|转账|删除|移除|清空|购买|下单|提交|确认|同意|授权|允许|安装|卸载|拨打|呼叫|send|pay|transfer|delete|remove|purchase|buy|submit|confirm|agree|allow|install|call", Pattern.CASE_INSENSITIVE);
    public static boolean confirmation(String action, String label, boolean coordinates) {
        return "tap".equals(action) && (label == null || !label.trim().matches("返回|取消|关闭|搜索|首页|联系人|通讯录|消息|聊天|发现|我|更多|设置")) || coordinates || "share_text".equals(action) || "alarm".equals(action) || "tap".equals(action) && SENSITIVE.matcher(label == null ? "" : label).find();
    }
    public static boolean validPackage(String value) { return value != null && value.matches("[A-Za-z][\\w]*(?:\\.[\\w]+)+"); }
    public static boolean active(long until, long now, boolean paused, boolean locked) { return until > now && !paused && !locked; }
    public static boolean ratio(double value) { return Double.isFinite(value) && value >= 0 && value <= 1; }
    public static boolean privateField(String text) { return text != null && Pattern.compile("密码|验证码|口令|密钥|password|passcode|one.time.code|api.?key", Pattern.CASE_INSENSITIVE).matcher(text).find(); }
    public static boolean secureTransport(String scheme, String host) {
        return "https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme) && ("127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host) || "10.0.2.2".equals(host));
    }
    private PhonePolicy() {}
}
