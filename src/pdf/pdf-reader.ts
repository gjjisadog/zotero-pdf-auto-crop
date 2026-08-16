/**
 * PDF 解析与页面渲染抽象（pdf-reader）。
 *
 * Zotero 不暴露 pdf.js（技术调查结论），因此插件自带 pdfjs-dist；
 * 渲染画布抽象为 CanvasBackend：Node（测试）用 @napi-rs/canvas，
 * Zotero 用 OffscreenCanvas（回退主窗口隐藏 canvas）。
 *
 * 职责划分：
 * - 页面盒（MediaBox/CropBox/TrimBox...）与写入由 pdf-writer（pdf-lib）负责；
 * - 本模块只负责「渲染」与「当前可见区域（view）」——view 即 pdf.js 的
 *   page.view（= 当前 CropBox，缺省 MediaBox，未旋转坐标）。
 *
 * 坐标管线（重要）：
 * 1. 渲染区域 = view（未旋转）；
 * 2. 像素 → 显示坐标（pt，左下原点，区域尺寸 = rotate(view) 尺寸）；
 * 3. 显示坐标 → 未旋转「view 区域」坐标（rotation.ts，size = view 尺寸）；
 * 4. + view 左下偏移 → 未旋转 MediaBox 坐标系。
 * 后续裁剪框计算全部使用 MediaBox 坐标系 + MediaBox 尺寸做旋转映射。
 */
import type { PageBox } from '../crop/bounding-box';
import { displayBoxToPdf } from '../crop/rotation';
import type { RenderedPage } from '../crop/page-analyzer';

export interface CanvasBackend {
  /** 返回具备 2D 渲染上下文的对象（DOM canvas / OffscreenCanvas / node canvas） */
  createCanvas(width: number, height: number): unknown;
}

export interface PdfDocumentHandle {
  readonly numPages: number;
  /** 页面当前可见区域（未旋转，= CropBox 或 MediaBox），1-based */
  getView(pageNumber: number): Promise<PageBox>;
  /** 渲染页面到指定 DPI 附近的位图（1-based）；scale 为实际渲染比例（可能降采样） */
  renderPage(pageNumber: number, dpi: number): Promise<RenderedPage & { scale: number; fontDataMissing: boolean }>;
  destroy(): void;
}

export interface PdfOpenOptions {
  /** pdfjs 标准字体数据目录（Node 为文件路径；Zotero 中为 chrome:// 资源 URL） */
  standardFontDataUrl?: string;
  canvasBackend?: CanvasBackend;
  /** pdf.js 的 ownerDocument（Zotero 中传主窗口 document；缺省自动探测） */
  ownerDocument?: unknown;
}

/** 渲染 DPI（≈0.18 mm/px，白边检测精度足够；100–120 均合理，默认 100） */
export const ANALYSIS_DPI = 100;
/** 分析位图单边像素上限（防超大页面爆内存） */
const MAX_RENDER_DIM = 2400;

/**
 * 打开 PDF（pdfjs-dist）。pdf.js 通过 `globalThis.pdfjsWorker`
 * （WorkerMessageHandler）走主线程 fake worker，无需真实 Worker，
 * Node 与 Firefox 特权环境均可用。
 */
export async function openPdfDocument(
  data: Uint8Array,
  options: PdfOpenOptions = {}
): Promise<PdfDocumentHandle> {
  const pdfjsLib: any = await loadPdfJs();
  // pdf.js 会 transfer（detach）传入的 buffer；复制一份以免破坏调用方数据
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(data),
    standardFontDataUrl: options.standardFontDataUrl,
    ownerDocument: options.ownerDocument ?? detectOwnerDocument(),
  }).promise;
  const backend = options.canvasBackend ?? createDefaultCanvasBackend();
  return new PdfJsDocument(pdf, backend);
}

async function loadPdfJs(): Promise<any> {
  const [pdfjsLib, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ]);
  if (!(globalThis as any).pdfjsWorker) {
    (globalThis as any).pdfjsWorker = worker;
  }
  return pdfjsLib;
}

/** 探测可用的 document（bootstrap 全局无 document，Zotero 需取主窗口） */
function detectOwnerDocument(): unknown {
  const g = globalThis as any;
  if (g.document) return g.document;
  try {
    if (typeof g.Zotero?.getMainWindow === 'function') {
      return g.Zotero.getMainWindow().document;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * 默认画布后端：环境探测。
 * 1. OffscreenCanvas（Firefox window/worker/部分特权环境）；
 * 2. Zotero 主窗口 document（bootstrap 全局无 document，但主窗口有）；
 * 3. 全局 document（浏览器）；
 * 4. 其他环境抛错（调用方显式传入 canvasBackend，如 Node 测试）。
 */
export function createDefaultCanvasBackend(): CanvasBackend {
  const g = globalThis as any;
  if (typeof g.OffscreenCanvas === 'function') {
    return {
      createCanvas(width: number, height: number) {
        return new g.OffscreenCanvas(width, height);
      },
    };
  }
  if (typeof g.Zotero !== 'undefined' && typeof g.Zotero.getMainWindow === 'function') {
    return {
      createCanvas(width: number, height: number) {
        const doc = g.Zotero.getMainWindow().document;
        const c = doc.createElement('canvas');
        c.width = width;
        c.height = height;
        return c;
      },
    };
  }
  if (typeof g.document !== 'undefined' && g.document.createElement) {
    return {
      createCanvas(width: number, height: number) {
        const c = g.document.createElement('canvas');
        c.width = width;
        c.height = height;
        return c;
      },
    };
  }
  throw new Error('No canvas backend available; pass canvasBackend explicitly');
}

/**
 * 基于 pdfjs-dist 的实现。
 * pdf.js 通过 `globalThis.pdfjsWorker`（WorkerMessageHandler）走主线程
 * fake worker，无需真实 Worker，Node 与 Firefox 特权环境均可用。
 */
export class PdfJsDocument implements PdfDocumentHandle {
  readonly numPages: number;

  constructor(
    private readonly pdf: any,
    private readonly backend: CanvasBackend
  ) {
    this.numPages = pdf.numPages;
  }

  async getView(pageNumber: number): Promise<PageBox> {
    const page = await this.pdf.getPage(pageNumber);
    try {
      const view: number[] = page.view;
      if (!view || view.length !== 4) {
        throw new Error(`Page ${pageNumber} has no valid view box`);
      }
      return { left: view[0], bottom: view[1], right: view[2], top: view[3] };
    } finally {
      page.cleanup();
    }
  }

  async renderPage(pageNumber: number, dpi: number): Promise<RenderedPage & { scale: number; fontDataMissing: boolean }> {
    const page = await this.pdf.getPage(pageNumber);
    try {
      let scale = dpi / 72;
      const viewport = page.getViewport({ scale: 1 });
      // 超大页面降采样，控制内存
      const maxDim = Math.max(viewport.width, viewport.height);
      if (maxDim * scale > MAX_RENDER_DIM) {
        scale = MAX_RENDER_DIM / maxDim;
      }
      const renderViewport = page.getViewport({ scale });
      const cw = Math.ceil(renderViewport.width);
      const ch = Math.ceil(renderViewport.height);
      const canvas: any = this.backend.createCanvas(cw, ch);
      const ctx = canvas.getContext('2d');

      // 字体加载检测：standard fonts / 嵌入字体缺失时 pdf.js 只打 console 警告
      // （文字不画出），静默失败会让内容盒漏检。渲染期间拦截警告标记该页。
      let fontDataMissing = false;
      const consoleAny = console as any;
      const origWarn = consoleAny.warn;
      consoleAny.warn = (...args: unknown[]) => {
        const msg = args.map(String).join(' ');
        if (/Unable to load font data|_path_|standardFontDataUrl|FetchStandardFontData/.test(msg)) {
          fontDataMissing = true;
        }
        if (typeof origWarn === 'function') origWarn.apply(console, args);
      };
      try {
        await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
      } finally {
        consoleAny.warn = origWarn;
      }

      const image = ctx.getImageData(0, 0, cw, ch);
      return {
        width: cw,
        height: ch,
        data: new Uint8ClampedArray(image.data),
        scale,
        fontDataMissing,
      };
    } finally {
      // cleanup 失败（如渲染中断后的状态不一致）不得掩盖原始渲染错误
      try {
        page.cleanup();
      } catch {
        /* ignore */
      }
    }
  }

  destroy(): void {
    this.pdf.destroy();
  }
}

/**
 * 显示坐标内容盒（pt，左下原点，相对 view 区域）→ 未旋转 MediaBox 坐标系。
 *
 * @param contentBoxDisplay 分析得到的显示坐标内容盒（pt）
 * @param view 渲染区域（未旋转 [left,bottom,right,top]，即当前 CropBox 或 MediaBox）
 * @param rotation 页面旋转（0/90/180/270）
 */
export function contentBoxToMediaBoxCoords(
  contentBoxDisplay: { left: number; bottom: number; right: number; top: number },
  view: PageBox,
  rotation: number
): PageBox {
  // H2-3：displayBoxToPdf 接收完整 view（含原点），内部做局部坐标旋转并加回原点
  return displayBoxToPdf(contentBoxDisplay, view, rotation as 0 | 90 | 180 | 270);
}

/** 显示坐标像素 → 显示坐标 pt（y 翻转） */
export function pixelsToDisplayPt(
  rendered: { width: number; height: number },
  pixelBox: { left: number; bottom: number; right: number; top: number },
  scale: number
): { left: number; bottom: number; right: number; top: number } {
  return {
    left: pixelBox.left / scale,
    bottom: (rendered.height - 1 - pixelBox.bottom) / scale,
    right: pixelBox.right / scale,
    top: (rendered.height - 1 - pixelBox.top) / scale,
  };
}
