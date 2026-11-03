import { defineConfig } from 'vite';
import { existsSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const installer = path.resolve(root, '../dist/GitCrest Setup 0.1.0.exe');
const releases = {
  windows: process.env.WEBSITE_WINDOWS_URL || null,
  macos: process.env.WEBSITE_MACOS_URL || null,
  linux: process.env.WEBSITE_LINUX_URL || null,
};

export default defineConfig({
  root,
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'esnext', rollupOptions: { input: { main: path.join(root, 'index.html'), demo: path.join(root, 'demo.html') } } },
  plugins: [react(), tailwindcss(), {
    name: 'gitcrest-website-releases',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] === '/releases.json') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ...releases, windows: releases.windows || (existsSync(installer) ? '/downloads/gitcrest-windows-preview.exe' : null) }));
        } else if (req.url === '/downloads/gitcrest-windows-preview.exe' && existsSync(installer)) {
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Disposition', 'attachment; filename="GitCrest-Setup-0.1.0.exe"');
          createReadStream(installer).on('error', () => res.destroy()).pipe(res);
        } else next();
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'releases.json', source: JSON.stringify(releases, null, 2) });
    },
    async writeBundle() {
      const fs = await import('node:fs/promises');
      await fs.copyFile(path.join(root, 'dist/index.html'), path.join(root, 'dist/404.html'));
    },
  }],
});
