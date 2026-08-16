/**
 * 构建 Zotero XPI（scripts/build-xpi.mjs）。
 *
 * 1. esbuild 打包 src/index.ts → build/content/scripts/zotero-pdf-auto-crop.js
 *    （IIFE，firefox115 目标；pdfjs-dist 与 pdf-lib 全部内联，零外部依赖）；
 * 2. 复制 addon/（manifest.json、bootstrap.js、icons）；
 * 3. 复制 pdfjs standard_fonts → content/standard_fonts/（经 bootstrap
 *    registerChrome 后以 chrome://zotero-pdf-auto-crop/content/... 访问）；
 * 4. zip 打包 → dist/zotero-pdf-auto-crop.xpi。
 */
import { build } from 'esbuild';
import { zip } from 'fflate';
import { mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const DIST = join(ROOT, 'dist');
const SCRIPTS = join(BUILD, 'content/scripts');
const FONTS = join(BUILD, 'content/standard_fonts');
const addonRef = 'zotero-pdf-auto-crop';

console.log(`Building ${pkg.name} v${pkg.version}`);

// 1. esbuild bundle
await rm(BUILD, { recursive: true, force: true });
await mkdir(SCRIPTS, { recursive: true });
await build({
  entryPoints: [join(ROOT, 'src/index.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'firefox115',
  outfile: join(SCRIPTS, `${addonRef}.js`),
  sourcemap: false,
  minify: process.env.ZPAC_NO_MINIFY ? false : true,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  // pdfjs-dist legacy build 内部引用，保持不动
  logLevel: 'info',
});

// 2. addon 静态文件（manifest/bootstrap/icons）
await cp(join(ROOT, 'addon'), BUILD, { recursive: true });

// 3. standard fonts（pdfjs 渲染标准 14 字体所需）
await mkdir(FONTS, { recursive: true });
await cp(join(ROOT, 'node_modules/pdfjs-dist/standard_fonts'), FONTS, { recursive: true });

// 3.1 第三方许可证（P1-5：发行包必须包含依赖许可文本）
const LICENSES = join(BUILD, 'licenses');
await mkdir(LICENSES, { recursive: true });
await cp(join(ROOT, 'node_modules/pdf-lib/LICENSE.md'), join(LICENSES, 'pdf-lib-LICENSE'));
await cp(join(ROOT, 'node_modules/pdfjs-dist/LICENSE'), join(LICENSES, 'pdfjs-LICENSE'));
await cp(join(FONTS, 'LICENSE_FOXIT'), join(LICENSES, 'standard_fonts-LICENSE_FOXIT'));
await cp(join(FONTS, 'LICENSE_LIBERATION'), join(LICENSES, 'standard_fonts-LICENSE_LIBERATION'));

// 4. 打包 XPI
await mkdir(DIST, { recursive: true });
const files = [];
async function collect(dir, base) {
  const { readdir } = await import('node:fs/promises');
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) {
      await collect(full, join(base, name.name));
    } else {
      files.push({ path: join(base, name.name), data: await readFile(full) });
    }
  }
}
await collect(BUILD, '');

const xpiPath = join(DIST, `${pkg.name.replace(/\s+/g, '-').toLowerCase()}-${pkg.version}.xpi`);
const zipped = await new Promise((resolve, reject) => {
  const input = {};
  for (const f of files) input[f.path] = [f.data, { level: 9 }];
  zip(input, (err, out) => (err ? reject(err) : resolve(out)));
});
await writeFile(xpiPath, zipped);

const totalBytes = files.reduce((s, f) => s + f.data.length, 0);
console.log(`XPI written: ${xpiPath} (${(zipped.length / 1024 / 1024).toFixed(2)} MB, ${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB unpacked)`);
