/**
 * 视觉抽查工具：裁剪前/后渲染指定页为 PNG，供视觉检查。
 * 用法: node scripts/visual-check.mjs <pdf> <page> <out-before> <out-after>
 * 先裁剪副本（原地替换），再渲染同一页对比。
 */
import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { copyFile, writeFile, readFile } from 'node:fs/promises';
import { CropService } from '../src/crop/crop-service.ts';
import { NodeFileSystem } from '../src/utils/temp-file-node.ts';
import { openPdfDocument } from '../src/pdf/pdf-reader.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STD_FONTS = join(ROOT, 'node_modules/pdfjs-dist/standard_fonts/');
const backend = {
  createCanvas(w, h) {
    return createCanvas(w, h);
  },
};

async function renderPage(pdfPath, pageNumber, outPath, dpi = 100) {
  const handle = await openPdfDocument(new Uint8Array(await readFile(pdfPath)), {
    standardFontDataUrl: STD_FONTS,
    canvasBackend: backend,
  });
  try {
    const rendered = await handle.renderPage(pageNumber, dpi);
    const canvas = createCanvas(rendered.width, rendered.height);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(rendered.width, rendered.height);
    img.data.set(rendered.data);
    ctx.putImageData(img, 0, 0);
    await writeFile(outPath, canvas.toBuffer('image/png'));
    console.log(`rendered ${outPath} (${rendered.width}x${rendered.height})`);
  } finally {
    handle.destroy();
  }
}

const [, , pdfPath, pageStr, beforePath, afterPath] = process.argv;
const page = parseInt(pageStr, 10);
const work = '/tmp/zpac-visual/work.pdf';
await copyFile(pdfPath, work);

// 裁剪前
await renderPage(work, page, beforePath);

// 裁剪（副本原地替换）
const service = new CropService();
const fs = new NodeFileSystem();
const result = await service.cropPdf({
  data: await fs.readFile(work),
  targetPath: work,
  fs,
  pdfOptions: { standardFontDataUrl: STD_FONTS, canvasBackend: backend },
  config: { requireEmbeddedFonts: false },
});
console.log('crop:', result.status, result.pageCount, 'pages, changed', result.changedPageCount);

// 裁剪后
await renderPage(work, page, afterPath);
