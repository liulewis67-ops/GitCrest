import { defineConfig } from 'vite';
import { existsSync, createReadStream, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(root, '../package.json'), 'utf8'));
const appVersion = pkg.version || '0.1.0';
const installer = path.resolve(root, `../dist/GitCrest Setup ${appVersion}.exe`);
const fallbackPublicUrl = 'https://liulewis67-ops.github.io/GitCrest/';
const publicUrl = (process.env.WEBSITE_PUBLIC_URL || fallbackPublicUrl).replace(/\/?$/, '/');
const releases = {
  windows: process.env.WEBSITE_WINDOWS_URL || null,
  macos: process.env.WEBSITE_MACOS_URL || null,
  linux: process.env.WEBSITE_LINUX_URL || null,
  githubRepository: process.env.WEBSITE_GITHUB_REPOSITORY || null,
};

function buildRobotsTxt(siteUrl) {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /demo.html',
    '',
    `Sitemap: ${new URL('sitemap.xml', siteUrl).href}`,
    '',
  ].join('\n');
}

function buildSitemapXml(siteUrl) {
  const lastmod = new Date().toISOString().slice(0, 10);
  const zhUrl = `${siteUrl}?lang=zh`;
  const enUrl = `${siteUrl}?lang=en`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>${siteUrl}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
    <xhtml:link rel="alternate" hreflang="zh-CN" href="${zhUrl}" />
    <xhtml:link rel="alternate" hreflang="en" href="${enUrl}" />
    <xhtml:link rel="alternate" hreflang="x-default" href="${siteUrl}" />
  </url>
  <url>
    <loc>${zhUrl}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
    <xhtml:link rel="alternate" hreflang="zh-CN" href="${zhUrl}" />
    <xhtml:link rel="alternate" hreflang="en" href="${enUrl}" />
    <xhtml:link rel="alternate" hreflang="x-default" href="${siteUrl}" />
  </url>
  <url>
    <loc>${enUrl}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
    <xhtml:link rel="alternate" hreflang="zh-CN" href="${zhUrl}" />
    <xhtml:link rel="alternate" hreflang="en" href="${enUrl}" />
    <xhtml:link rel="alternate" hreflang="x-default" href="${siteUrl}" />
  </url>
</urlset>
`;
}

export default defineConfig({
  root,
  base: process.env.WEBSITE_BASE_PATH || '/',
  define: {
    __GITCREST_APP_VERSION__: JSON.stringify(appVersion),
    __GITCREST_PUBLIC_URL__: JSON.stringify(publicUrl),
  },
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'esnext', rollupOptions: { input: { main: path.join(root, 'index.html'), demo: path.join(root, 'demo.html') } } },
  plugins: [react(), tailwindcss(), {
    name: 'gitcrest-website-releases',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const image = new URL('assets/social.png', publicUrl).href;
        return html
          .replaceAll('%PUBLIC_URL%', publicUrl)
          .replaceAll('%APP_VERSION%', appVersion)
          .replaceAll('%BASE_URL%assets/social.png', image);
      },
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const reqPath = req.url?.split('?')[0];
        if (reqPath === '/releases.json') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ...releases, windows: releases.windows || (existsSync(installer) ? '/downloads/gitcrest-windows-preview.exe' : null) }));
        } else if (reqPath === '/robots.txt') {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(buildRobotsTxt(publicUrl));
        } else if (reqPath === '/sitemap.xml') {
          res.setHeader('Content-Type', 'application/xml; charset=utf-8');
          res.end(buildSitemapXml(publicUrl));
        } else if (req.url === '/downloads/gitcrest-windows-preview.exe' && existsSync(installer)) {
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Disposition', `attachment; filename="GitCrest-Setup-${appVersion}.exe"`);
          createReadStream(installer).on('error', () => res.destroy()).pipe(res);
        } else next();
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'releases.json', source: JSON.stringify(releases, null, 2) });
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: buildRobotsTxt(publicUrl) });
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: buildSitemapXml(publicUrl) });
    },
    async writeBundle() {
      const fs = await import('node:fs/promises');
      await fs.copyFile(path.join(root, 'dist/index.html'), path.join(root, 'dist/404.html'));
    },
  }],
});
