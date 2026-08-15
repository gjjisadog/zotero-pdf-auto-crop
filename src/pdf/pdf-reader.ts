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
  renderPage(pageNumber: number, dpi: number): Promise<RenderedPage & { scale: number }>;
  destroy(): void;
}

export interface PdfOpenOptions {
  /** pdfjs 标准字体数据目录（Node 为文件路径；Zotero 中为 chrome:// 资源 URL） */
  standardFontDataUrl?: string;
  canvasBackend?: CanvasBackend;
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

/** 默认画布后端：环境探测（浏览器 OffscreenCanvas → DOM canvas → Node canvas） */
export function createDefaultCanvasBackend(): CanvasBackend {
  const g = globalThis as any;
  if (typeof g.OffscreenCanvas === 'function') {
    return {
      createCanvas(width: number, height: number) {
        return new g.OffscreenCanvas(width, height);
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

  async renderPage(pageNumber: number, dpi: number): Promise<RenderedPage & { scale: number }> {
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
      await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
      const image = ctx.getImageData(0, 0, cw, ch);
      return {
        width: cw,
        height: ch,
        data: new Uint8ClampedArray(image.data),
        scale,
      };
    } finally {
      page.cleanup();
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
  const viewSize = { width: view.right - view.left, height: view.top - view.bottom };
  const unrotated = displayBoxToPdf(contentBoxDisplay, viewSize, rotation as 0 | 90 | 180 | 270);
  return {
    left: unrotated.left + view.left,
    bottom: unrotated.bottom + view.bottom,
    right: unrotated.right + view.left,
    top: unrotated.top + view.bottom,
  };
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
