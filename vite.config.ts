import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { normalizeBase } from './src/config/base.ts';

/**
 * Build-only Content-Security-Policy meta tag (design §16, ocr-design §5).
 * Same-origin only. `'wasm-unsafe-eval'` and `worker-src 'self'` are what the
 * self-hosted OCR worker needs (no `blob:`, the worker is a classic
 * same-origin script). The dev server gets no CSP (Vite injects inline HMR code).
 */
export const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'";

function cspMeta(): Plugin {
  return {
    name: 'mrd-csp-meta',
    apply: 'build',
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }];
    },
  };
}

// The public base path comes from VITE_BASE (shell env wins over .env files,
// e.g. `.env.pages` for the GitHub Pages build). Default: '/'.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: normalizeBase(env.VITE_BASE ?? '/'),
    plugins: [react(), cspMeta()],
  };
});
