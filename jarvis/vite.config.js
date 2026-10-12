import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * 两种构建：
 *   npm run build              正常版：dist/，配合 server/server.mjs（网关 + 自托管 WASM / 模型）
 *   npm run build:standalone   单文件版：所有代码、样式、胸像网格都内联进一个 HTML，双击即可打开；
 *                              没有网关时对话走浏览器内置智能体（或用户自己填写的 Claude 密钥），
 *                              人脸 / 语音检测的模型改从公共 CDN 加载（只下载，不上传）
 *   npm run build:mobile       安卓 App：dist-mobile/，相对路径、不带自托管模型（同单文件版从 CDN 加载），由 Capacitor 打包成 APK
 */
export default defineConfig(({ mode }) => {
  const standalone = mode === 'standalone';
  const mobile = mode === 'mobile';
  return {
    base: standalone || mobile ? './' : '/',
    define: { __STANDALONE__: JSON.stringify(standalone || mobile), __MOBILE__: JSON.stringify(mobile) },
    plugins: standalone ? [viteSingleFile()] : [],
    publicDir: standalone || mobile ? false : 'public',
    assetsInclude: ['**/*.bin'],
    server: {
      port: 5173,
      // 开发时把 /api 转给网关（npm run server）
      proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } }
    },
    worker: { format: 'es' },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 4000,
      outDir: standalone ? 'dist-standalone' : mobile ? 'dist-mobile' : 'dist',
      // 正常版另有桌面背景页（桌面版用）；单文件版、手机版只有一个页面
      ...(!standalone && !mobile && { rollupOptions: { input: { main: 'index.html', wallpaper: 'wallpaper.html' } } }),
      ...(standalone && { assetsInlineLimit: 100 * 1024 * 1024 })
    },
    optimizeDeps: { exclude: ['@ricky0123/vad-web', 'onnxruntime-web'] },
    test: { environment: 'node', include: ['tests/**/*.test.{js,mjs}'] }
  };
});
