import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In sviluppo: backend su :3000 (npm run dev in /backend)
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
