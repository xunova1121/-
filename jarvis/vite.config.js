import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // 开发时把 /api 转给网关（npm run server）
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } }
  },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  optimizeDeps: { exclude: ['@ricky0123/vad-web', 'onnxruntime-web'] },
  test: { environment: 'node', include: ['tests/**/*.test.{js,mjs}'] }
});
