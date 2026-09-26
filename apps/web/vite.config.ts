import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Ports come from the checkout's root .env (scripts/dev/agent-env.sh gives each worktree its own API/web port).
const rootEnv = loadEnv('development', fileURLToPath(new URL('../..', import.meta.url)), '');
const apiPort = Number(process.env.API_PORT ?? rootEnv.API_PORT ?? 4000);
const webPort = Number(process.env.WEB_PORT ?? (rootEnv.APP_BASE_URL ? new URL(rootEnv.APP_BASE_URL).port : '') ?? 5173) || 5173;

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['ksp-src'], dedupe: ['react', 'react-dom'], alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: webPort,
    strictPort: true,
    // Same-origin in development so SameSite=Strict cookies and CSP work exactly as in production (behind one ingress).
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
  // `vite preview` (used by the E2E suite: the built bundle, same-origin /api proxy, same port as dev).
  preview: { port: webPort, strictPort: true, host: '127.0.0.1', proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } } },
  build: { sourcemap: true, chunkSizeWarningLimit: 1500 },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], include: ['src/**/*.test.tsx', 'src/**/*.test.ts'] },
} as never);
