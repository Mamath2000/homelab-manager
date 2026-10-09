import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

const hub = process.env.HUB_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    proxy: {
      '/api': { target: hub, changeOrigin: false },
      '/install.sh': hub,
      '/agent': { target: hub, ws: true },
    },
  },
});
