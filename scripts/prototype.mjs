/**
 * Phase 2 最小技术原型（Node 环境）：
 *   sample.pdf → 渲染第一页 → 像素分析 content bbox → +2mm padding
 *   → pdf-lib 写 CropBox + 保存原始盒元数据 → sample-cropped.pdf
 *   → 重新解析验证 → 恢复原始盒 → sample-restored.pdf → 验证还原
 *
 * 运行: node scripts/prototype.mjs
 */
import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, StandardFonts, rgb, PDFName, PDFString, PDFDict } from 'pdf-lib';
import fs from 'node:fs/promises';

// ---- pdf.js 单线程（fake worker）模式 ----
globalThis.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
const stdFontsPath = join(dirname(fileURLToPath(import.meta.url)), '../node_modules/pdfjs-dist/standard_fonts/');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'prototype-out');
await fs.mkdir(OUT, { recursive: true });

const MM_TO_PT = 72 / 25.4;
const SAFE_MARGIN_PT = 2 * MM_TO_PT; // 2 mm
const DPI = 100;

// ---- 1. 生成 sample.pdf：A4 页面，内容集中在中部，四周大边距 ----
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]); // A4
  page.drawText('Sample Paper Title', { x: 130, y: 700, size: 22, font, color: rgb(0, 0, 0) });
  page.drawText('This is a paragraph of body text that occupies the middle of the page.', {
    x: 130, y: 640, size: 12, font, color: rgb(0.1, 0.1, 0.1),
  });
  page.drawRectangle({ x: 160, y: 480, width: 240, height: 120, color: rgb(0.2, 0.4, 0.8) });
  page.drawText('1', { x: 290, y: 100, size: 10, font, color: rgb(0.3, 0.3, 0.3) }); // 页脚页码
  await fs.writeFile(join(OUT, 'sample.pdf'), await doc.save());
  console.log('1. sample.pdf generated (A4, content in the middle)');
}

// ---- 2. 分析：渲染第一页 → 像素分析 content bbox ----
const bytes = await fs.readFile(join(OUT, 'sample.pdf'));
const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: stdFontsPath }).promise;
console.log('2. parsed:', pdf.numPages, 'page(s)');

const page1 = await pdf.getPage(1);
const rotate = page1.rotate;
const viewport = page1.getViewport({ scale: DPI / 72 });
const canvas = createCanvas(viewport.width, viewport.height);
const ctx = canvas.getContext('2d');
await page1.render({ canvasContext: ctx, viewport }).promise;
const img = ctx.getImageData(0, 0, viewport.width, viewport.height);
const { data, width: w, height: h } = img;

// 简单阈值：内容 = 非近白像素
let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a > 128 && (r < 245 || g < 245 || b < 245)) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
console.log(`3. pixel bbox (canvas, ${w}x${h}): (${minX}, ${minY}) - (${maxX}, ${maxY})`);

// canvas 坐标（y 向下）→ PDF 坐标（y 向上，未旋转）
const scale = DPI / 72;
const toPdfX = (px) => px / scale;
const toPdfY = (py) => (h - py) / scale;
// PDF 页面盒坐标：content box 用 [left, bottom, right, top]
const contentBox = {
  left: toPdfX(minX),
  bottom: toPdfY(maxY),
  right: toPdfX(maxX),
  top: toPdfY(minY),
};
console.log('4. content box (PDF pt):', JSON.stringify(contentBox));

// ---- 3. 裁剪框 = content box + 2mm padding（钳制在页面内）----
const [pw, ph] = [viewport.width / scale, viewport.height / scale];
const cropBox = {
  left: Math.max(0, contentBox.left - SAFE_MARGIN_PT),
  bottom: Math.max(0, contentBox.bottom - SAFE_MARGIN_PT),
  right: Math.min(pw, contentBox.right + SAFE_MARGIN_PT),
  top: Math.min(ph, contentBox.top + SAFE_MARGIN_PT),
};
console.log(`5. crop box (PDF pt): ${JSON.stringify(cropBox)} (2mm = ${SAFE_MARGIN_PT.toFixed(2)}pt)`);

// ---- 4. pdf-lib 写入：保存原始盒元数据 + 修改 CropBox ----
const doc = await PDFDocument.load(bytes, { updateMetadata: false });
const p = doc.getPage(0);
const origCrop = p.getCropBox();
const origMedia = p.getMediaBox();
console.log('6. original boxes:', JSON.stringify({ media: origMedia, crop: origCrop }));

// 元数据：Info 字典自定义键（原型简化；正式实现为 XMP + Info 双写）
const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
if (!info) throw new Error('no Info dict');
info.set(
  PDFName.of('ZoteroPdfAutoCropRestore'),
  PDFString.of(JSON.stringify({ version: 1, pages: [{ crop: origCrop, media: origMedia }] }))
);

p.setCropBox(cropBox.left, cropBox.bottom, cropBox.right - cropBox.left, cropBox.top - cropBox.bottom);
// 同步 TrimBox/BleedBox/ArtBox（若存在）
for (const name of ['TrimBox', 'BleedBox', 'ArtBox']) {
  // pdf-lib 没有按名删除/读取任意盒的 API；原型只设置 CropBox，正式实现处理全部盒
}
await fs.writeFile(join(OUT, 'sample-cropped.pdf'), await doc.save({ updateFieldAppearances: false }));
console.log('7. sample-cropped.pdf written (CropBox updated, original saved in Info)');

// ---- 5. 验证输出 ----
{
  const vdoc = await PDFDocument.load(await fs.readFile(join(OUT, 'sample-cropped.pdf')), { updateMetadata: false });
  const vp = vdoc.getPage(0);
  const c = vp.getCropBox();
  const ok = Math.abs(c.x - cropBox.left) < 0.01 && Math.abs(c.width - (cropBox.right - cropBox.left)) < 0.01;
  console.log(`8. verify: page count=${vdoc.getPageCount()}, CropBox=${JSON.stringify(c)}, ${ok ? 'PASS' : 'FAIL'}`);
  const vinfo = vdoc.context.lookup(vdoc.context.trailerInfo.Info, PDFDict);
  const restore = vinfo.get(PDFName.of('ZoteroPdfAutoCropRestore'));
  console.log('9. restore metadata preserved:', restore ? 'PASS' : 'FAIL');
}

// ---- 6. 恢复原始盒 ----
{
  const rdoc = await PDFDocument.load(await fs.readFile(join(OUT, 'sample-cropped.pdf')), { updateMetadata: false });
  const rinfo = rdoc.context.lookup(rdoc.context.trailerInfo.Info, PDFDict);
  const saved = JSON.parse(rinfo.get(PDFName.of('ZoteroPdfAutoCropRestore')).decodeText());
  const rp = rdoc.getPage(0);
  rp.setCropBox(saved.pages[0].crop.x, saved.pages[0].crop.y, saved.pages[0].crop.width, saved.pages[0].crop.height);
  await fs.writeFile(join(OUT, 'sample-restored.pdf'), await rdoc.save({ updateFieldAppearances: false }));
  const fdoc = await PDFDocument.load(await fs.readFile(join(OUT, 'sample-restored.pdf')), { updateMetadata: false });
  const fc = fdoc.getPage(0).getCropBox();
  const ok = Math.abs(fc.x - origCrop.x) < 0.01 && Math.abs(fc.y - origCrop.y) < 0.01
    && Math.abs(fc.width - origCrop.width) < 0.01 && Math.abs(fc.height - origCrop.height) < 0.01;
  console.log(`10. restore: CropBox=${JSON.stringify(fc)} == original ${JSON.stringify(origCrop)} -> ${ok ? 'PASS' : 'FAIL'}`);
}

// ---- 7. 文本层仍在（非栅格化验证）----
{
  const tpdf = await pdfjsLib.getDocument({ data: new Uint8Array(await fs.readFile(join(OUT, 'sample-cropped.pdf'))), standardFontDataUrl: stdFontsPath }).promise;
  const tpage = await tpdf.getPage(1);
  const tc = await tpage.getTextContent();
  const text = tc.items.map(i => i.str).join(' ');
  console.log(`11. text layer intact: "${text.slice(0, 60)}..." -> ${text.includes('Sample Paper Title') ? 'PASS' : 'FAIL'}`);
}
console.log('\nprototype DONE');
