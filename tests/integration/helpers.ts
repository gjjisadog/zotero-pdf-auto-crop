/**
 * 集成测试辅助：Node 环境的 CropService 配置、渲染验证工具。
 */
import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { CropService, type CropResult } from '../../src/crop/crop-service';
import { NodeFileSystem } from '../../src/utils/temp-file-node';
import { openPdfDocument, type PdfDocumentHandle } from '../../src/pdf/pdf-reader';
import { analyzePagePixels } from '../../src/crop/page-analyzer';

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export const STD_FONTS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'node_modules',
  'pdfjs-dist',
  'standard_fonts',
  '/'
);

export function makeNodeCanvasBackend() {
  return {
    createCanvas(width: number, height: number) {
      return createCanvas(width, height);
    },
  };
}

export interface TestContext {
  dir: string;
  fs: NodeFileSystem;
}

/** 每个测试独立的临时目录 */
export async function makeContext(): Promise<TestContext> {
  const dir = await mkdtemp(join(tmpdir(), 'zpac-int-'));
  return { dir, fs: new NodeFileSystem() };
}

export async function cleanupContext(ctx: TestContext): Promise<void> {
  await rm(ctx.dir, { recursive: true, force: true });
}

/** 把 fixture 复制到临时目录并返回目标路径 */
export async function copyFixture(ctx: TestContext, name: string): Promise<string> {
  const dest = join(ctx.dir, name);
  await copyFile(join(FIXTURES_DIR, name), dest);
  return dest;
}

export async function readFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(FIXTURES_DIR, name)));
}

/** 运行裁剪（Node 环境） */
export async function runCrop(ctx: TestContext, targetPath: string, config: any = {}): Promise<CropResult> {
  const service = new CropService();
  const data = await ctx.fs.readFile(targetPath);
  return service.cropPdf({
    data,
    targetPath,
    fs: ctx.fs,
    pdfOptions: {
      standardFontDataUrl: STD_FONTS_PATH,
      canvasBackend: makeNodeCanvasBackend(),
    },
    config: { requireEmbeddedFonts: false, ...config },
  });
}

/** 运行恢复 */
export async function runRestore(ctx: TestContext, targetPath: string): Promise<CropResult> {
  const service = new CropService();
  const data = await ctx.fs.readFile(targetPath);
  return service.restorePdf({
    data,
    targetPath,
    fs: ctx.fs,
    pdfOptions: {
      standardFontDataUrl: STD_FONTS_PATH,
      canvasBackend: makeNodeCanvasBackend(),
    },
  });
}

export async function openPdf(data: Uint8Array): Promise<PdfDocumentHandle> {
  return openPdfDocument(data, {
    standardFontDataUrl: STD_FONTS_PATH,
    canvasBackend: makeNodeCanvasBackend(),
  });
}

/** 渲染页面并分析内容盒（显示坐标，pt，相对可见区域左下角） */
export async function renderAndAnalyze(
  handle: PdfDocumentHandle,
  pageNumber: number,
  dpi = 100
): Promise<{ content: { left: number; bottom: number; right: number; top: number } | null; width: number; height: number }> {
  const rendered = await handle.renderPage(pageNumber, dpi);
  const px = analyzePagePixels(rendered);
  const scale = rendered.scale;
  const content = px.contentBox
    ? {
        left: px.contentBox.left / scale,
        bottom: px.contentBox.bottom / scale,
        right: px.contentBox.right / scale,
        top: px.contentBox.top / scale,
      }
    : null;
  return { content, width: rendered.width / scale, height: rendered.height / scale };
}
