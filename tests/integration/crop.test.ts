/**
 * 集成测试：裁剪 → 重新打开 → 验证（任务 §46）。
 *
 * 覆盖：页数不变、文本层保留、内容不被切、restore 恢复原始盒、
 * 多次裁剪基于原始盒、outline/annotation 保留、特殊页处理。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PDFDocument, PDFName, PDFArray } from 'pdf-lib';
import {
  makeContext, cleanupContext, copyFixture, runCrop, runRestore,
  openPdf, renderAndAnalyze, readFixture, type TestContext,
} from './helpers';
import { boxFromRect } from '../../src/crop/bounding-box';
import { DEFAULT_CROP_CONFIG } from '../../src/crop/crop-model';

const contexts: TestContext[] = [];
afterEach(async () => {
  for (const c of contexts.splice(0)) await cleanupContext(c);
});

async function ctx(): Promise<TestContext> {
  const c = await makeContext();
  contexts.push(c);
  return c;
}

describe('integration: crop pipeline', () => {
  it('01-normal-paper: 裁剪有效、页数不变、文本保留、内容不切、可恢复', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '01-normal-paper.pdf');
    const before = await openPdf(await c.fs.readFile(path));

    const result = await runCrop(c, path);
    expect(result.status).toBe('cropped');
    expect(result.pageCount).toBe(5);
    expect(result.changedPageCount).toBe(5);

    // 重新打开输出
    const after = await openPdf(await c.fs.readFile(path));
    expect(after.numPages).toBe(5);
    expect(result.pageCount).toBe(after.numPages);

    // 文本层保留
    const text = await extractText(after, 1);
    expect(text).toContain('Synthetic Paper Title');

    // 裁剪框有效且内容不切：渲染输出，内容盒在裁剪框内（有 padding）
    const { content, width, height } = await renderAndAnalyze(after, 1);
    expect(content).not.toBeNull();
    // 可见区域 = CropBox；内容盒（显示坐标）应在可见区域内，且不触边（padding ≥ 1pt 容差）
    expect(content!.left).toBeGreaterThanOrEqual(1);
    expect(content!.bottom).toBeGreaterThanOrEqual(1);
    expect(content!.right).toBeLessThanOrEqual(width - 1);
    expect(content!.top).toBeLessThanOrEqual(height - 1);
    before.destroy();
    after.destroy();
  });

  it('01-normal-paper: 裁剪后 crop box 显著小于原始（白边被去除）', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '01-normal-paper.pdf');
    const orig = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const origCrop = orig.getPage(0).getCropBox();
    await runCrop(c, path);
    const out = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const newCrop = out.getPage(0).getCropBox();
    const origArea = origCrop.width * origCrop.height;
    const newArea = newCrop.width * newCrop.height;
    // 60pt 边距 + 页脚/标题 -> 裁剪后面积应小于原始 75%
    expect(newArea / origArea).toBeLessThan(0.75);
    expect(newCrop.width).toBeLessThan(origCrop.width);
    expect(newCrop.height).toBeLessThan(origCrop.height);
  });

  it('01-normal-paper: 裁剪→恢复→页面盒等于原始', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '01-normal-paper.pdf');
    const orig = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const origBoxes = [];
    for (let i = 0; i < orig.getPageCount(); i++) {
      const p = orig.getPage(i);
      origBoxes.push({ x: p.getCropBox().x, y: p.getCropBox().y, width: p.getCropBox().width, height: p.getCropBox().height });
    }

    await runCrop(c, path);
    const restored = await runRestore(c, path);
    expect(restored.status).toBe('restored');
    expect(restored.changedPageCount).toBe(5);

    const out = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    expect(out.getPageCount()).toBe(5);
    for (let i = 0; i < 5; i++) {
      const b = out.getPage(i).getCropBox();
      expect(Math.abs(b.x - origBoxes[i].x)).toBeLessThan(0.01);
      expect(Math.abs(b.y - origBoxes[i].y)).toBeLessThan(0.01);
      expect(Math.abs(b.width - origBoxes[i].width)).toBeLessThan(0.01);
      expect(Math.abs(b.height - origBoxes[i].height)).toBeLessThan(0.01);
    }
  });

  it('01-normal-paper: 多次裁剪始终基于原始盒（H2-1：幂等 + 篡改后仍恢复正确）', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '01-normal-paper.pdf');
    const first = await runCrop(c, path);
    expect(first.status).toBe('cropped');
    const afterFirst = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const firstCrops = [];
    for (let i = 0; i < afterFirst.getPageCount(); i++) {
      const b = afterFirst.getPage(i).getCropBox();
      firstCrops.push({ x: b.x, y: b.y, width: b.width, height: b.height });
    }

    // 第二次裁剪：H2-1 修复后基于「原始可见区域」分析，结果与第一次一致 → 幂等
    const second = await runCrop(c, path);
    expect(['cropped', 'no-change']).toContain(second.status);
    const afterSecond = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    for (let i = 0; i < afterSecond.getPageCount(); i++) {
      const b = afterSecond.getPage(i).getCropBox();
      expect(Math.abs(b.x - firstCrops[i].x)).toBeLessThan(1.5);
      expect(Math.abs(b.y - firstCrops[i].y)).toBeLessThan(1.5);
      expect(Math.abs(b.width - firstCrops[i].width)).toBeLessThan(1.5);
      expect(Math.abs(b.height - firstCrops[i].height)).toBeLessThan(1.5);
    }

    // 核心语义：多次裁剪不覆盖原始盒（恢复元数据始终指向最初状态）
    const info = (afterSecond as any).context.lookup((afterSecond as any).context.trailerInfo.Info);
    const restore = JSON.parse(info.get(PDFName.of('ZoteroPdfAutoCropRestore')).decodeText());
    // fixture 01 原本没有 CropBox（显示即 MediaBox）→ 恢复元数据应为 null（P1-1 精确语义）
    expect(restore.pages[0].crop).toBeNull();

    // 强验证：手动把 CropBox 篡改成错误值后再次裁剪，必须仍能恢复正确裁剪
    // （证明分析基于原始盒，而不是当前被篡改的 CropBox）
    const { writeFile } = await import('node:fs/promises');
    const tampered = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    for (let i = 0; i < tampered.getPageCount(); i++) {
      tampered.getPage(i).setCropBox(300, 300, 50, 50); // 严重错误裁剪
    }
    await writeFile(path, await tampered.save());

    const third = await runCrop(c, path);
    expect(third.status).toBe('cropped');
    const afterThird = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    for (let i = 0; i < afterThird.getPageCount(); i++) {
      const b = afterThird.getPage(i).getCropBox();
      expect(Math.abs(b.x - firstCrops[i].x)).toBeLessThan(1.5);
      expect(Math.abs(b.y - firstCrops[i].y)).toBeLessThan(1.5);
      expect(Math.abs(b.width - firstCrops[i].width)).toBeLessThan(1.5);
      expect(Math.abs(b.height - firstCrops[i].height)).toBeLessThan(1.5);
    }
  });

  it('02-two-column: 双栏论文可裁剪且内容不切', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '02-two-column-paper.pdf');
    const result = await runCrop(c, path);
    expect(result.status).toBe('cropped');
    const handle = await openPdf(await c.fs.readFile(path));
    for (let p = 1; p <= 4; p++) {
      const { content, width, height } = await renderAndAnalyze(handle, p);
      expect(content).not.toBeNull();
      expect(content!.left).toBeGreaterThanOrEqual(1);
      expect(content!.right).toBeLessThanOrEqual(width - 1);
      expect(content!.bottom).toBeGreaterThanOrEqual(1);
      expect(content!.top).toBeLessThanOrEqual(height - 1);
    }
    handle.destroy();
  });

  it('03-large-margin: 大边距论文显著裁剪', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '03-large-margin-paper.pdf');
    await runCrop(c, path);
    const out = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const b = out.getPage(0).getCropBox();
    // 150pt 边距 -> 裁剪后显著小于原始（内容区 ~323x567）
    expect(b.width).toBeLessThan(400);
    expect(b.height).toBeLessThan(600);
  });

  it('04-scanned: 扫描件裁剪后内容不切', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '04-scanned-paper.pdf');
    const result = await runCrop(c, path);
    expect(result.status).toBe('cropped');
    const handle = await openPdf(await c.fs.readFile(path));
    for (let p = 1; p <= 3; p++) {
      const { content, width, height } = await renderAndAnalyze(handle, p);
      expect(content).not.toBeNull();
      // 内容盒（显示坐标）不触边：白边已被裁掉，内容周围有 padding
      expect(content!.left).toBeGreaterThanOrEqual(1);
      expect(content!.bottom).toBeGreaterThanOrEqual(1);
      expect(content!.right).toBeLessThanOrEqual(width - 1);
      expect(content!.top).toBeLessThanOrEqual(height - 1);
    }
    handle.destroy();
  });

  it('05-book-odd-even: 奇偶页获得不同裁剪框（镜像页边距）', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '05-book-odd-even.pdf');
    const result = await runCrop(c, path);
    expect(result.status).toBe('cropped');
    const out = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const page0 = out.getPage(0).getCropBox(); // 偶数（0-based）
    const page1 = out.getPage(1).getCropBox(); // 奇数
    // 0-based 偶数页内侧在右（left 边距小），奇数页内侧在左（left 边距大）
    expect(Math.abs(page0.x - page1.x)).toBeGreaterThan(10);
  });

  it('06-landscape: 旋转页与横向页裁剪正确且内容不切', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '06-landscape-pages.pdf');
    const result = await runCrop(c, path);
    expect(result.status).toBe('cropped');
    const handle = await openPdf(await c.fs.readFile(path));
    for (let p = 1; p <= 3; p++) {
      const { content, width, height } = await renderAndAnalyze(handle, p);
      expect(content, `page ${p}`).not.toBeNull();
      expect(content!.left).toBeGreaterThanOrEqual(0.5);
      expect(content!.bottom).toBeGreaterThanOrEqual(0.5);
      expect(content!.right).toBeLessThanOrEqual(width - 0.5);
      expect(content!.top).toBeLessThanOrEqual(height - 0.5);
    }
    handle.destroy();
  });

  it('07-mixed-size: 混合尺寸各自分组处理', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '07-mixed-page-size.pdf');
    const result = await runCrop(c, path);
    expect(result.status).toBe('cropped');
    const out = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    expect(out.getPageCount()).toBe(4);
    for (let i = 0; i < 4; i++) {
      const b = out.getPage(i).getCropBox();
      expect(b.width).toBeGreaterThan(0);
      expect(b.height).toBeGreaterThan(0);
      // CropBox 必须在 MediaBox 内
      const m = out.getPage(i).getMediaBox();
      expect(b.x).toBeGreaterThanOrEqual(m.x - 0.01);
      expect(b.y).toBeGreaterThanOrEqual(m.y - 0.01);
      expect(b.x + b.width).toBeLessThanOrEqual(m.x + m.width + 0.01);
      expect(b.y + b.height).toBeLessThanOrEqual(m.y + m.height + 0.01);
    }
  });

  it('08-full-page-image: 整页图页不裁剪，正常页裁剪', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '08-full-page-image.pdf');
    const result = await runCrop(c, path);
    expect(result.status).toBe('cropped');
    // 页 1（整页图）changed=false
    const pageCrops = result.pageCrops!;
    expect(pageCrops[0].changed).toBe(false);
    expect(pageCrops[1].changed).toBe(true);
    // 整页图页 CropBox 保持 MediaBox
    const out = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const cover = out.getPage(0).getCropBox();
    expect(cover.width).toBe(612);
    expect(cover.height).toBe(792);
  });

  it('09-small-margin: 小边距页不裁剪或极小裁剪（不切内容）', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '09-small-margin.pdf');
    const result = await runCrop(c, path);
    expect(['cropped', 'no-change']).toContain(result.status);
    const out = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const b = out.getPage(0).getCropBox();
    // 裁剪后的宽高不得小于内容所需（30pt 边距 + 2mm padding 至少 > 40pt 边）
    expect(b.width).toBeGreaterThan(500);
    expect(b.height).toBeGreaterThan(650);
  });

  it('10-annotated: 内嵌批注/书签/链接在裁剪与恢复后保留，且 Rect 坐标不变（P1-2）', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '10-annotated.pdf');
    const before = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const annotsBefore = annotRects(before);
    const outlinesBefore = countOutlines(before);
    expect(annotsBefore.length).toBeGreaterThan(0);

    await runCrop(c, path);
    const cropped = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    expect(annotRects(cropped)).toEqual(annotsBefore); // 数量与坐标都一致
    expect(countOutlines(cropped)).toBe(outlinesBefore);

    await runRestore(c, path);
    const restored = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    expect(annotRects(restored)).toEqual(annotsBefore);
    expect(countOutlines(restored)).toBe(outlinesBefore);
    // 恢复后无 CropBox（fixture 原本没有）→ 显示即 MediaBox
    const node = (restored.getPage(0) as any).node;
    expect(node.get(PDFName.of('CropBox'))).toBeUndefined();
  });

  it('恢复元数据写入 PDF 内部（无第二附件）', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '01-normal-paper.pdf');
    await runCrop(c, path);
    const out = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const info = (out as any).context.lookup((out as any).context.trailerInfo.Info);
    const key = info?.get(PDFName.of('ZoteroPdfAutoCropRestore'));
    expect(key).toBeDefined();
  });
});

/** 提取页面文本（验证文本层保留） */
async function extractText(handle: Awaited<ReturnType<typeof openPdf>>, pageNumber: number): Promise<string> {
  const page = await (handle as any).pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items.map((i: any) => i.str).join(' ');
}

/** 收集所有页面批注的 Rect（用于裁剪/恢复前后的一致性比较） */
function annotRects(doc: PDFDocument): { page: number; rect: { x: number; y: number; width: number; height: number } }[] {
  const out: { page: number; rect: { x: number; y: number; width: number; height: number } }[] = [];
  for (let i = 0; i < doc.getPageCount(); i++) {
    const node = (doc.getPage(i) as any).node;
    const annots = node.get(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    for (let j = 0; j < annots.size(); j++) {
      const ref = annots.get(j);
      const dict = doc.context.lookup(ref) as any;
      if (!dict || typeof dict.get !== 'function') continue;
      const rect = dict.get(PDFName.of('Rect'));
      if (rect instanceof PDFArray) {
        out.push({ page: i, rect: rect.asRectangle() });
      }
    }
  }
  return out;
}

function countOutlines(doc: PDFDocument): number {
  const outlines = (doc.catalog as any).get(PDFName.of('Outlines'));
  return outlines ? 1 : 0;
}

void readFixture;
void boxFromRect;
void DEFAULT_CROP_CONFIG;

describe('integration: P1-1 only CropBox is modified', () => {
  it('带 TrimBox/BleedBox 的 PDF：裁剪只写 CropBox，其他盒原样', async () => {
    const { PDFDocument, PDFName, StandardFonts, rgb } = await import('pdf-lib');
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const c = await ctx();
    const path = join(c.dir, 'with-trim.pdf');

    // 构造：MediaBox [0 0 612 792]，CropBox [20 20 592 772]（出版商预裁剪），TrimBox/BleedBox 同 CropBox
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.setCropBox(20, 20, 572, 752);
    page.setTrimBox(20, 20, 572, 752);
    page.setBleedBox(20, 20, 572, 752);
    page.drawText('Body text with publisher crop marks', { x: 100, y: 500, size: 14, font, color: rgb(0, 0, 0) });
    await writeFile(path, await doc.save());

    const result = await runCrop(c, path);
    expect(result.status).toBe('cropped');

    const out = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const node = (out.getPage(0) as any).node;
    const crop = node.get(PDFName.of('CropBox'));
    const trim = node.get(PDFName.of('TrimBox'));
    const bleed = node.get(PDFName.of('BleedBox'));
    // CropBox 被裁剪（变小）
    const cropRect = crop.asRectangle();
    expect(cropRect.width).toBeLessThan(572);
    // TrimBox/BleedBox 原样保留（P1-1：不碰印刷语义盒）
    const trimRect = trim.asRectangle();
    expect(trimRect.x).toBe(20);
    expect(trimRect.width).toBe(572);
    const bleedRect = bleed.asRectangle();
    expect(bleedRect.x).toBe(20);
    expect(bleedRect.width).toBe(572);
  });
});
