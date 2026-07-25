import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// GitHub Pages serves this app from a subpath (https://muhammadali-k.github.io/evidence-digest/),
// but the same build also needs to work at a custom domain root. VITE_BASE lets CI override the
// default subpath; everything else (router basename, API base) derives from import.meta.env.BASE_URL
// at runtime rather than hardcoding a path anywhere else in the app.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/evidence-digest/',
  plugins: [react(), tailwindcss()],
  build: {
    sourcemap: true,
  },
});
