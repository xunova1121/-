package com.xunova.jarvis;

import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.provider.AlarmClock;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.JSArray;
import java.util.List;

final class PhoneIntents {
    static JSArray apps(android.content.Context context) {
        Intent query = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> found = context.getPackageManager().queryIntentActivities(query, 0);
        found.sort((a,b) -> String.valueOf(a.loadLabel(context.getPackageManager())).compareTo(String.valueOf(b.loadLabel(context.getPackageManager()))));
        JSArray rows = new JSArray(); java.util.HashSet<String> seen = new java.util.HashSet<>();
        for (ResolveInfo r : found) {
            String pkg = r.activityInfo.packageName; if (pkg.equals(context.getPackageName()) || !seen.add(pkg)) continue;
            JSObject row = new JSObject(); row.put("label", PhoneScreen.chars(r.loadLabel(context.getPackageManager()))); row.put("packageName", pkg); rows.put(row); if (rows.length() >= 200) break;
        }
        return rows;
    }
    static boolean run(PhoneAccessibilityService service, JSObject command) throws Exception {
        String action = command.optString("action"); Intent intent;
        switch (action) {
            case "open_app":
                String pkg = command.optString("packageName"); service.requireApp(pkg);
                if (!PhonePolicy.validPackage(pkg) || pkg.equals(service.getPackageName())) throw new Exception("PHONE_APP_DENIED");
                intent = service.getPackageManager().getLaunchIntentForPackage(pkg); break;
            case "alarm":
                int hour = command.optInt("hour", -1), minute = command.optInt("minute", -1);
                if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Exception("PHONE_ARGUMENT");
                intent = new Intent(AlarmClock.ACTION_SET_ALARM).putExtra(AlarmClock.EXTRA_HOUR, hour).putExtra(AlarmClock.EXTRA_MINUTES, minute).putExtra(AlarmClock.EXTRA_MESSAGE, command.optString("label", "未央提醒")).putExtra(AlarmClock.EXTRA_SKIP_UI, false); break;
            case "navigate": intent = new Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(limited(command.optString("destination"), 300)))); break;
            case "dial":
                String number = command.optString("number"); if (!number.matches("\\+?[0-9 ()-]{3,30}")) throw new Exception("PHONE_ARGUMENT");
                intent = new Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null)); break;
            case "share_text": intent = Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, limited(command.optString("text"), 2000)), "选择分享应用"); break;
            default: return false;
        }
        if (intent == null || intent.resolveActivity(service.getPackageManager()) == null) throw new Exception("PHONE_APP_MISSING");
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); service.startActivity(intent); return true;
    }
    static String limited(String value, int max) throws Exception { if (value == null || value.trim().isEmpty() || value.length() > max) throw new Exception("PHONE_ARGUMENT"); return value; }
    private PhoneIntents() {}
}
