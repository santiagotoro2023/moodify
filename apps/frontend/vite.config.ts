import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Dev only. In production the backend serves this build from the same origin.
    proxy: {
      '/api': 'http://localhost:8080',
      '/assets-store': 'http://localhost:8080',
    },
  },
});
