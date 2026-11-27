package com.xunova.jarvis;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/**
 * 从相册、微信、文件管理器“分享 → 未央”：把分享来的文件复制到 App 自己的缓存目录（share-in/批次编号/），
 * 网页用 Capacitor.convertFileSrc 读出来，交给输入框原有的上传流程（和点 ＋ 选文件一样）。
 * 大文件不经 base64 走桥；网页还没打开（冷启动）时先攒着，网页来 take() 时一次给；读完网页调 done() 删缓存。
 * 上限和清理规则见 ShareIntakePolicy。不新增存储权限：只读系统授予这次分享的那几个文件。
 */
@CapacitorPlugin(name = "ShareIntake")
public class ShareIntakePlugin extends Plugin {
    private final ArrayDeque<JSObject> pending = new ArrayDeque<>(); // 最多 ShareIntakePolicy.MAX_PENDING 批

    private File root() { return new File(getContext().getCacheDir(), "share-in"); }

    @Override public void load() {
        // 清掉超过一天还没被取走的旧批次（App 被杀、用户没登录等情况留下的）
        new Thread(() -> {
            File[] dirs = root().listFiles();
            if (dirs == null) return;
            long now = System.currentTimeMillis();
            for (File d : dirs) if (ShareIntakePolicy.expired(d.lastModified(), now)) deleteTree(d);
        }).start();
    }

    /** MainActivity 收到分享时调用（后台线程里复制文件，不卡界面） */
    void receive(Intent intent) {
        new Thread(() -> {
            JSObject batch = copy(intent);
            if (batch == null) return;
            synchronized (pending) {
                while (pending.size() >= ShareIntakePolicy.MAX_PENDING) {
                    JSObject old = pending.removeFirst();
                    deleteTree(new File(root(), old.getString("id", "")));
                }
                pending.addLast(batch);
            }
            notifyListeners("shared", new JSObject(), true); // 网页在的话马上来取；不在的话等它打开时自己 take()
        }).start();
    }

    @PluginMethod public void take(PluginCall call) {
        JSArray batches = new JSArray();
        synchronized (pending) {
            while (!pending.isEmpty()) batches.put(pending.removeFirst());
        }
        JSObject ret = new JSObject();
        ret.put("batches", batches);
        call.resolve(ret);
    }

    @PluginMethod public void done(PluginCall call) {
        String id = call.getString("id", "");
        if (ShareIntakePolicy.validId(id)) deleteTree(new File(root(), id));
        call.resolve();
    }

    private JSObject copy(Intent intent) {
        ArrayList<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        String text = ShareIntakePolicy.clipText(intent.getStringExtra(Intent.EXTRA_TEXT));
        if (uris.isEmpty() && text == null) return null;
        String id = UUID.randomUUID().toString().replace("-", "");
        File dir = new File(root(), id);
        JSArray files = new JSArray();
        Set<String> used = new HashSet<>();
        long total = 0;
        int skipped = 0;
        ContentResolver resolver = getContext().getContentResolver();
        for (int i = 0; i < uris.size(); i++) {
            Uri u = uris.get(i);
            try {
                long size = sizeOf(resolver, u);
                if (!ShareIntakePolicy.accept(files.length(), Math.max(size, 0), total)) { skipped++; continue; }
                if (!dir.isDirectory() && !dir.mkdirs()) { skipped++; continue; }
                String name = ShareIntakePolicy.unique(ShareIntakePolicy.safeName(displayName(resolver, u), i), used);
                File out = new File(dir, name);
                long copied = copyLimited(resolver, u, out, Math.min(ShareIntakePolicy.MAX_FILE, ShareIntakePolicy.MAX_TOTAL - total));
                if (copied < 0) { out.delete(); skipped++; continue; } // 实际比声称的大：超限不收
                total += copied;
                JSObject f = new JSObject();
                f.put("path", out.getAbsolutePath());
                f.put("name", name);
                f.put("type", resolver.getType(u));
                f.put("size", copied);
                files.put(f);
            } catch (Exception e) {
                skipped++;
            }
        }
        JSObject batch = new JSObject();
        batch.put("id", id);
        batch.put("files", files);
        batch.put("skipped", skipped);
        if (text != null) batch.put("text", text);
        return batch;
    }

    private static String displayName(ContentResolver resolver, Uri u) {
        try (Cursor c = resolver.query(u, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) { /* 拿不到名字就用默认的 */ }
        return u.getLastPathSegment();
    }

    private static long sizeOf(ContentResolver resolver, Uri u) {
        try (Cursor c = resolver.query(u, new String[] { OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) { /* 不知道大小就边复制边数 */ }
        return -1;
    }

    /** 复制，超过 limit 就停并返回 -1 */
    private static long copyLimited(ContentResolver resolver, Uri u, File out, long limit) throws Exception {
        try (InputStream in = resolver.openInputStream(u); OutputStream os = new FileOutputStream(out)) {
            if (in == null) return -1;
            byte[] buf = new byte[64 * 1024];
            long n = 0;
            int r;
            while ((r = in.read(buf)) > 0) {
                n += r;
                if (n > limit) return -1;
                os.write(buf, 0, r);
            }
            return n;
        }
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }
}
