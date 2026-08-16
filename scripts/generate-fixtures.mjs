/**
 * 生成合成测试 PDF fixtures（tests/fixtures/）。
 *
 * 全部由 pdf-lib 程序化生成（无版权问题）。特征与任务 §44 对应：
 * 01 普通论文 / 02 双栏 / 03 大边距 / 04 扫描件（灰度 PNG+噪点，无文本层）
 * 05 书籍奇偶 / 06 横向页 / 07 混合尺寸 / 08 整页图 / 09 小边距 / 10 内嵌批注+书签
 *
 * 运行: node scripts/generate-fixtures.mjs
 */
import { PDFDocument, StandardFonts, rgb, PDFName, PDFDict, PDFString, PDFHexString } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');
await mkdir(OUT, { recursive: true });

const LETTER = [612, 792];
const A4 = [595.28, 841.89];
const INK = rgb(0.1, 0.1, 0.1);

/** 画一页"论文正文"：标题 + 若干段落行 + 页脚页码 */
async function drawPaperPage(doc, font, page, opts = {}) {
  const {
    title = 'Synthetic Paper Title',
    margin = 60,
    twoColumn = false,
    lineGap = 14,
    lineCount = 24,
    footer = true,
    innerOffset = 0, // 奇偶镜像：内侧额外边距
    startY = 700,
  } = opts;
  const [w, h] = [page.getWidth(), page.getHeight()];
  const titleY = h - margin - 30;
  page.drawText(title, { x: margin + innerOffset, y: titleY, size: 18, font, color: INK });

  const bodyStart = Math.min(startY, titleY - 40);
  if (twoColumn) {
    const colW = (w - 2 * margin) / 2 - 12;
    for (let c = 0; c < 2; c++) {
      const x0 = margin + c * (colW + 24);
      for (let i = 0; i < lineCount; i++) {
        const y = bodyStart - i * lineGap;
        page.drawText(`Column ${c + 1} line ${i + 1}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor.`,
          { x: x0, y, size: 10, font, color: INK, maxWidth: colW });
      }
    }
  } else {
    for (let i = 0; i < lineCount; i++) {
      const y = bodyStart - i * lineGap;
      page.drawText(`Line ${i + 1}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.`,
        { x: margin + innerOffset, y, size: 10, font, color: INK, maxWidth: w - 2 * margin - innerOffset });
    }
  }

  if (footer) {
    page.drawText('1', { x: w / 2 - 3, y: margin / 2, size: 9, font, color: rgb(0.3, 0.3, 0.3) });
  }
}

/** 扫描件页面：灰底 PNG（带噪点与阴影边）嵌入，无文本层 */
function makeScannedPageImage(wPt, hPt, seed = 1) {
  const scale = 100 / 72;
  const w = Math.round(wPt * scale);
  const h = Math.round(hPt * scale);
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  // 纸色背景（带轻微噪点）
  ctx.fillStyle = 'rgb(244,243,239)';
  ctx.fillRect(0, 0, w, h);
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 4000; i++) {
    const g = 235 + Math.floor(rand() * 18);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(Math.floor(rand() * w), Math.floor(rand() * h), 1, 1);
  }
  // 边缘阴影（左/上渐变带）
  const shade = ctx.createLinearGradient(0, 0, Math.round(w * 0.04), 0);
  shade.addColorStop(0, 'rgba(80,80,80,0.25)');
  shade.addColorStop(1, 'rgba(80,80,80,0)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, Math.round(w * 0.04), h);
  // 正文块（黑色矩形模拟文字行）
  ctx.fillStyle = 'rgb(30,30,30)';
  const m = 70 * scale;
  for (let i = 0; i < 20; i++) {
    const y = h - (m + 60 * scale) - i * 16 * scale;
    const x = m + 20 * scale;
    const lw = (w - 2 * m) * (0.8 + rand() * 0.15);
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(lw), Math.round(4.5 * scale));
  }
  return c.toBuffer('image/png');
}

// ---------- 01 普通论文 ----------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < 5; p++) {
    const page = doc.addPage(LETTER);
    await drawPaperPage(doc, font, page, { startY: 700 - p * 8, lineGap: 14 });
  }
  await writeFile(join(OUT, '01-normal-paper.pdf'), await doc.save());
}

// ---------- 02 双栏论文 ----------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < 4; p++) {
    const page = doc.addPage(LETTER);
    await drawPaperPage(doc, font, page, { twoColumn: true, startY: 700 - p * 6 });
  }
  await writeFile(join(OUT, '02-two-column-paper.pdf'), await doc.save());
}

// ---------- 03 大边距论文（150pt 边距） ----------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < 3; p++) {
    const page = doc.addPage(LETTER);
    await drawPaperPage(doc, font, page, { margin: 150, startY: 700 - p * 4, lineCount: 12 });
  }
  await writeFile(join(OUT, '03-large-margin-paper.pdf'), await doc.save());
}

// ---------- 04 扫描件（无文本层） ----------
{
  const doc = await PDFDocument.create();
  for (let p = 0; p < 3; p++) {
    const page = doc.addPage(LETTER);
    const png = makeScannedPageImage(LETTER[0], LETTER[1], p + 7);
    const image = await doc.embedPng(png);
    page.drawImage(image, { x: 0, y: 0, width: LETTER[0], height: LETTER[1] });
  }
  await writeFile(join(OUT, '04-scanned-paper.pdf'), await doc.save());
}

// ---------- 05 书籍奇偶（镜像页边距，12 页） ----------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < 12; p++) {
    const page = doc.addPage(LETTER);
    // 0-based 偶数页 = 书籍左页（内侧=右），奇数页 = 右页（内侧=左）
    const isLeftPage = p % 2 === 0;
    const inner = 130; // 内侧边距
    const outer = 55;  // 外侧边距
    const leftMargin = isLeftPage ? outer : inner;
    const rightMargin = isLeftPage ? inner : outer;
    const [w] = LETTER;
    for (let i = 0; i < 26; i++) {
      const y = 690 - i * 13;
      page.drawText(`Page ${p + 1} line ${i + 1}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt.`,
        { x: leftMargin, y, size: 10, font, color: INK, maxWidth: w - leftMargin - rightMargin });
    }
    page.drawText(String(p + 1), { x: w / 2 - 3, y: 40, size: 9, font, color: rgb(0.3, 0.3, 0.3) });
  }
  await writeFile(join(OUT, '05-book-odd-even.pdf'), await doc.save());
}

// ---------- 06 横向页（宽页 + 90° 旋转页混合） ----------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // 宽页面（792x612 横向）
  const wide = doc.addPage([792, 612]);
  wide.drawText('Landscape page title', { x: 80, y: 520, size: 18, font, color: INK });
  for (let i = 0; i < 18; i++) {
    wide.drawText(`Landscape line ${i + 1}: lorem ipsum dolor sit amet consectetur adipiscing elit.`,
      { x: 80, y: 480 - i * 15, size: 10, font, color: INK, maxWidth: 630 });
  }
  // 90° 旋转页（Letter 旋转 90）
  for (let p = 0; p < 2; p++) {
    const page = doc.addPage(LETTER);
    page.setRotation({ type: 'degrees', angle: 90 });
    page.drawText('Rotated page title', { x: 90, y: 560, size: 16, font, color: INK });
    for (let i = 0; i < 14; i++) {
      page.drawText(`Rotated line ${i + 1}: lorem ipsum dolor sit amet consectetur.`,
        { x: 90, y: 520 - i * 14, size: 10, font, color: INK, maxWidth: 420 });
    }
  }
  await writeFile(join(OUT, '06-landscape-pages.pdf'), await doc.save());
}

// ---------- 07 混合页面尺寸（Letter + A4） ----------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < 2; p++) {
    const page = doc.addPage(LETTER);
    await drawPaperPage(doc, font, page, { startY: 700, lineCount: 20 });
  }
  for (let p = 0; p < 2; p++) {
    const page = doc.addPage(A4);
    await drawPaperPage(doc, font, page, { startY: 740, lineCount: 24 });
  }
  await writeFile(join(OUT, '07-mixed-page-size.pdf'), await doc.save());
}

// ---------- 08 整页图 + 正常页 ----------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // 整页图（全页蓝色矩形）
  const cover = doc.addPage(LETTER);
  cover.drawRectangle({ x: 0, y: 0, width: LETTER[0], height: LETTER[1], color: rgb(0.15, 0.3, 0.65) });
  cover.drawText('Full Page Figure', { x: 200, y: 400, size: 24, font, color: rgb(1, 1, 1) });
  for (let p = 0; p < 3; p++) {
    const page = doc.addPage(LETTER);
    await drawPaperPage(doc, font, page, { startY: 700 - p * 5, lineCount: 22 });
  }
  await writeFile(join(OUT, '08-full-page-image.pdf'), await doc.save());
}

// ---------- 09 小边距（几乎不裁剪） ----------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(LETTER);
  page.drawText('Tight margin doc', { x: 30, y: 762, size: 16, font, color: INK });
  for (let i = 0; i < 40; i++) {
    page.drawText(`Line ${i + 1}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
      { x: 30, y: 730 - i * 13, size: 9, font, color: INK, maxWidth: 552 });
  }
  page.drawText('end', { x: 30, y: 40, size: 9, font, color: INK });
  await writeFile(join(OUT, '09-small-margin.pdf'), await doc.save());
}

// ---------- 10 内嵌批注 + 书签 + 链接 + 元数据 ----------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(LETTER);
  page.drawText('Annotated Document', { x: 80, y: 700, size: 20, font, color: INK });
  page.drawText('This is the highlighted sentence for testing.', { x: 80, y: 660, size: 12, font, color: INK });
  page.drawText('This is the second paragraph with a link target.', { x: 80, y: 620, size: 12, font, color: INK });
  const page2 = doc.addPage(LETTER);
  page2.drawText('Second page', { x: 80, y: 700, size: 20, font, color: INK });

  // Highlight annotation（第一个页面）
  const highlight = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: [78, 650, 330, 672],
    QuadPoints: [78, 650, 330, 650, 78, 672, 330, 672],
    C: [1, 0.8, 0],
    T: 'TestUser',
  });
  const annots = doc.context.obj([doc.context.register(highlight)]);
  page.node.set(PDFName.of('Annots'), annots);

  // Link annotation（第二页）
  const link = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [80, 610, 300, 632],
    Border: [0, 0, 0],
    A: { S: 'URI', URI: 'https://example.com/' },
  });
  const annots2 = doc.context.obj([doc.context.register(link)]);
  page.node.set(PDFName.of('Annots'), annots2);

  // Outline（书签）
  const outline = doc.context.obj({
    Type: 'Outlines',
    First: doc.context.register(doc.context.obj({
      Title: 'First Section',
      Parent: null,
      Dest: [doc.context.register(page.node), 'Fit'],
      Next: doc.context.register(doc.context.obj({
        Title: 'Second Section',
        Parent: null,
        Dest: [doc.context.register(page2.node), 'Fit'],
      })),
    })),
    Last: null,
    Count: 2,
  });
  doc.catalog.set(PDFName.of('Outlines'), doc.context.register(outline));

  // 元数据
  doc.setTitle('Annotated Fixture');
  doc.setAuthor('Zotero PDF Auto Crop');
  doc.setSubject('fixture');

  await writeFile(join(OUT, '10-annotated.pdf'), await doc.save());
}

// ---------- 11 非零 MediaBox 原点（[20 30 632 822]） ----------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < 2; p++) {
    const page = doc.addPage([612, 792]);
    page.setMediaBox(20, 30, 612, 792);
    page.drawText('Nonzero origin page title', { x: 20 + 80, y: 30 + 690, size: 18, font, color: INK });
    for (let i = 0; i < 20; i++) {
      page.drawText(`Line ${i + 1}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt.`,
        { x: 20 + 80, y: 30 + 650 - i * 14, size: 10, font, color: INK, maxWidth: 452 });
    }
  }
  await writeFile(join(OUT, '11-nonzero-mediabox.pdf'), await doc.save());
}

// ---------- 12 负原点 MediaBox + 旋转 90（[-20 -30 592 762]） ----------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < 2; p++) {
    const page = doc.addPage([612, 792]);
    page.setMediaBox(-20, -30, 612, 792);
    page.setRotation({ type: 'degrees', angle: 90 });
    page.drawText('Negative origin rotated title', { x: -20 + 90, y: -30 + 560, size: 16, font, color: INK });
    for (let i = 0; i < 14; i++) {
      page.drawText(`Rotated line ${i + 1}: lorem ipsum dolor sit amet consectetur.`,
        { x: -20 + 90, y: -30 + 520 - i * 14, size: 10, font, color: INK, maxWidth: 420 });
    }
  }
  await writeFile(join(OUT, '12-negative-origin-rotated.pdf'), await doc.save());
}

// ---------- 13 继承 CropBox（父 Pages 节点设置，页面自身没有） ----------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // 根 Pages 设置 CropBox（沿 Page Tree 继承）
  const pages = doc.catalog.Pages();
  pages.set(PDFName.of('CropBox'), doc.context.obj([20, 20, 592, 772]));
  for (let p = 0; p < 2; p++) {
    const page = doc.addPage([612, 792]);
    page.drawText('Inherited cropbox page title', { x: 100, y: 700, size: 16, font, color: INK });
    for (let i = 0; i < 18; i++) {
      page.drawText(`Line ${i + 1}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt.`,
        { x: 100, y: 660 - i * 14, size: 10, font, color: INK, maxWidth: 450 });
    }
  }
  await writeFile(join(OUT, '13-inherited-cropbox.pdf'), await doc.save());
}

// ---------- 14 同尺寸不同 MediaBox 原点（正文视觉位置相同） ----------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const draw = (page, ox, oy) => {
    page.drawText('Mixed origin page title', { x: ox + 80, y: oy + 690, size: 16, font, color: INK });
    for (let i = 0; i < 18; i++) {
      page.drawText(`Line ${i + 1}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt.`,
        { x: ox + 80, y: oy + 650 - i * 14, size: 10, font, color: INK, maxWidth: 452 });
    }
  };
  const p1 = doc.addPage([612, 792]);
  p1.setMediaBox(20, 30, 612, 792);
  draw(p1, 20, 30);
  const p2 = doc.addPage([612, 792]);
  p2.setMediaBox(-20, -30, 612, 792);
  draw(p2, -20, -30);
  await writeFile(join(OUT, '14-mixed-mediabox-origin-same-size.pdf'), await doc.save());
}

console.log('fixtures generated in', OUT);
