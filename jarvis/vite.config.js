import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * 两种构建：
 *   npm run build              正常版：dist/，配合 server/server.mjs（网关 + 自托管 WASM / 模型）
 *   npm run build:standalone   单文件版：所有代码、样式、胸像网格都内联进一个 HTML，双击即可打开；
 *                              没有网关时对话走浏览器内置智能体（或用户自己填写的 Claude 密钥），
 *                              人脸 / 语音检测的模型改从公共 CDN 加载（只下载，不上传）
 */
export default defineConfig(({ mode }) => {
  const standalone = mode === 'standalone';
  return {
    base: standalone ? './' : '/',
    define: { __STANDALONE__: JSON.stringify(standalone) },
    plugins: standalone ? [viteSingleFile()] : [],
    publicDir: standalone ? false : 'public',
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
      outDir: standalone ? 'dist-standalone' : 'dist',
      // 正常版另有桌面背景页（桌面版用）；单文件版只有一个页面
      ...(!standalone && { rollupOptions: { input: { main: 'index.html', wallpaper: 'wallpaper.html' } } }),
      ...(standalone && { assetsInlineLimit: 100 * 1024 * 1024 })
    },
    optimizeDeps: { exclude: ['@ricky0123/vad-web', 'onnxruntime-web'] },
    test: { environment: 'node', include: ['tests/**/*.test.{js,mjs}'] }
  };
});
