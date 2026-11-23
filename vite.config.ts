import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  base: './',
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '0.0.0.0',
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
