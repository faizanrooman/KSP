import base from './vite.config';
const b = base as unknown as { server: Record<string, unknown> };
export default { ...(base as object), server: { ...b.server, port: 5213, proxy: { '/api': { target: 'http://127.0.0.1:4040', changeOrigin: false } } } };
