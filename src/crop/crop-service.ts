/**
 * 裁剪服务（crop-service）：核心链路编排（任务 §55 核心链路）。
 *
 * cropPdf:
 *   读取原始盒（首次裁剪时保存为恢复元数据，再次裁剪复用）
 *   → 逐页低分辨率渲染分析 → Content Bounding Boxes
 *   → Document Layout（尺寸/旋转分组 + 奇偶自动识别 + 异常页）
 *   → 稳定化裁剪框 + 2mm 安全边距
 *   → pdf-lib 修改 CropBox（临时文件）
 *   → 重新解析校验 → 原子替换原文件
 *
 * restorePdf:
 *   读取恢复元数据 → 恢复 MediaBox/CropBox 等 → 临时文件 → 校验 → 替换
 *
 * 本层不依赖 Zotero UI；右键菜单、未来批量/自动裁剪共用同一入口。
 */
import type { CropConfig, PageAnalysis, PageCrop } from '../crop/crop-model';
import { DEFAULT_CROP_CONFIG } from '../crop/crop-model';
import { analyzePagePixels, type PixelAnalyzeOptions } from '../crop/page-analyzer';
import { computePageCrops } from '../crop/stabilization';
import { analyzeLayout } from '../crop/document-layout';
import { ANALYSIS_DPI, type PdfDocumentHandle, type PdfOpenOptions, openPdfDocument, contentBoxToMediaBoxCoords } from '../pdf/pdf-reader';
import { PdfWriter, type PageBoxes } from '../pdf/pdf-writer';
import { createRestoreMetadata, type RestoreMetadata } from '../pdf/crop-metadata';
import { SafeReplacer, type FileSystem } from '../utils/temp-file';
import { log } from '../utils/logger';
import { boxesEqual, clampBox } from '../crop/bounding-box';

export type CropStatus = 'cropped' | 'no-change' | 'restored';

export type CropErrorKind =
  | 'encrypted'       // 加密 PDF（任务 §30：拒绝）
  | 'signed'          // 数字签名 PDF（任务 §31：拒绝）
  | 'damaged'         // 解析失败（任务 §32：保留原文件）
  | 'no-restore-data' // 恢复时没有元数据
  | 'restore-mismatch' // 恢复数据页数与文档不符
  | 'io'              // 文件系统错误
  | 'validation'      // 输出校验失败
  | 'unsupported'     // 其他不支持的情况
  | 'unknown';

export class CropError extends Error {
  readonly kind: CropErrorKind;

  constructor(kind: CropErrorKind, message: string, cause?: unknown) {
    super(
      cause instanceof Error ? `${message} [${cause.message}]` : message,
      cause !== undefined ? { cause } : undefined
    );
    this.name = 'CropError';
    this.kind = kind;
  }
}

export interface CropResult {
  status: CropStatus;
  pageCount: number;
  /** 实际修改了页面盒的页数 */
  changedPageCount: number;
  /** 裁剪前各页原始盒（供 UI 展示/日志） */
  originalBoxes?: PageBoxes[];
  /** 每页最终裁剪框 */
  pageCrops?: PageCrop[];
  message?: string;
}

export interface CropRequest {
  /** 原文件字节 */
  data: Uint8Array;
  /** 原文件路径（替换目标；临时文件写入同目录） */
  targetPath: string;
  /** 文件系统（Zotero 用 IOUtils，测试用 Node fs） */
  fs: FileSystem;
  /** pdf.js 打开选项（standardFontDataUrl、canvas 后端） */
  pdfOptions: PdfOpenOptions;
  config?: Partial<CropConfig>;
  dpi?: number;
  onProgress?: (stage: 'analyzing' | 'applying' | 'saving' | 'verifying', page: number, total: number) => void;
}

export class CropService {
  async cropPdf(request: CropRequest): Promise<CropResult> {
    const config: CropConfig = { ...DEFAULT_CROP_CONFIG, ...request.config };
    const dpi = request.dpi ?? ANALYSIS_DPI;
    // 统一归一化输入字节：调用方可能传入其他 realm 的 TypedArray
    const data = new Uint8Array(request.data);
    const { targetPath, fs, pdfOptions } = request;
    const progress = request.onProgress ?? (() => {});
    const replacer = new SafeReplacer(fs);

    // 1. 安全检测
    if (PdfWriter.scanForDigitalSignature(data)) {
      throw new CropError(
        'signed',
        '此 PDF 包含数字签名，修改 PDF 会使签名失效，因此插件未执行裁剪。'
      );
    }

    // 2. 加载（pdf-lib）：加密 → EncryptedPDFError；损坏 → 解析异常
    let writer: PdfWriter;
    try {
      writer = await PdfWriter.open(data);
    } catch (e: any) {
      if (String(e?.message).includes('encrypted')) {
        throw new CropError('encrypted', '此 PDF 已加密，插件不会修改受保护的 PDF。', e);
      }
      throw new CropError('damaged', 'PDF 解析失败，原文件未做任何修改。', e);
    }
    const pageCount = writer.pageCount;
    if (pageCount === 0) {
      throw new CropError('unsupported', 'PDF 不包含任何页面。');
    }

    // 3. 原始盒：已有恢复元数据则复用（多次裁剪始终基于最初的原始盒）
    const existing = writer.getRestoreMetadata();
    let restoreMetadata: RestoreMetadata;
    if (existing) {
      if (existing.pages.length !== pageCount) {
        throw new CropError(
          'restore-mismatch',
          '已保存的原始页面信息与当前页数不符，无法安全裁剪。'
        );
      }
      restoreMetadata = existing;
      log.debug(`Reusing existing restore metadata (${pageCount} pages)`);
    } else {
      const boxes: PageBoxes[] = [];
      for (let i = 0; i < pageCount; i++) boxes.push(writer.getPageBoxes(i));
      restoreMetadata = createRestoreMetadata(boxes.map((b) => ({ crop: b.crop })));
    }

    // 4. 逐页渲染分析。
    // H2-1：二次裁剪必须基于「原始可见区域」分析，而不是当前（已被裁剪的）CropBox。
    // 有恢复元数据时，先在内存中把 CropBox 恢复为原始值，再用该副本做渲染分析。
    let analysisData: Uint8Array = data;
    if (restoreMetadata) {
      const analysisWriter = await PdfWriter.open(data);
      for (let i = 0; i < pageCount; i++) {
        analysisWriter.setPageCrop(i, restoreMetadata.pages[i].crop);
      }
      analysisData = await analysisWriter.save();
    }
    const pdfHandle = await this.openPdf(analysisData, pdfOptions);
    try {
      const analyses = await this.analyzeAllPages(pdfHandle, writer, pageCount, dpi, progress, config);

      // 5. 布局 + 稳定化
      const layout = analyzeLayout(analyses, config);
      const pageCrops = computePageCrops(analyses, layout, config);

      const changed = pageCrops.filter((c) => c.changed);
      if (changed.length === 0) {
        log.info('No crop needed for any page');
        return {
          status: 'no-change',
          pageCount,
          changedPageCount: 0,
          pageCrops,
          message: '未检测到明显白边，页面未做修改（内容已接近页面边缘，或页面使用了无法安全分析的字体）',
        };
      }

      // 6. 应用裁剪框 + 写入恢复元数据（首次）。
      // H2-2：最终 CropBox 必须 ⊆ 原始可见区域（Original CropBox ∩ MediaBox），
      // 绝不 reveal 用户原本看不到的内容（裁切线/出血/印刷标记）。
      for (const crop of pageCrops) {
        if (!crop.changed) continue;
        const boxes = writer.getPageBoxes(crop.pageIndex);
        const baseVisible = restoreMetadata.pages[crop.pageIndex].crop ?? boxes.media;
        const finalCrop = clampBox(crop.cropBox, baseVisible);
        if (!boxesEqual(finalCrop, crop.cropBox)) {
          log.debug(`page ${crop.pageIndex + 1}: crop clamped to original visible box`);
        }
        crop.cropBox = finalCrop;
        writer.setPageCrop(crop.pageIndex, finalCrop);
        progress('applying', crop.pageIndex + 1, pageCount);
      }
      writer.setRestoreMetadata(restoreMetadata);

      // 7. 保存到临时文件
      progress('saving', 0, pageCount);
      let outBytes: Uint8Array;
      try {
        outBytes = await writer.save();
      } catch (e) {
        throw new CropError('unknown', 'PDF 写入失败，原文件未做任何修改。', e);
      }

      // 8. 校验输出
      await this.verifyOutput(outBytes, pageCount, pageCrops);

      // 9. 原子替换
      let tempPath: string;
      try {
        tempPath = await replacer.stage(targetPath, outBytes);
      } catch (e) {
        throw new CropError('io', '写入临时文件失败，原文件未做任何修改。', e);
      }
      try {
        await replacer.replace(tempPath, targetPath);
      } catch (e) {
        await replacer.cleanup(tempPath);
        throw new CropError('io', '替换原文件失败，原文件未做任何修改。', e);
      }

      log.info(`Cropped ${changed.length}/${pageCount} pages -> ${targetPath}`);
      return {
        status: 'cropped',
        pageCount,
        changedPageCount: changed.length,
        pageCrops,
        message: 'PDF 白边裁剪完成',
      };
    } finally {
      pdfHandle.destroy();
    }
  }

  async restorePdf(request: Omit<CropRequest, 'dpi'>): Promise<CropResult> {
    const data = new Uint8Array(request.data);
    const { targetPath, fs, pdfOptions } = request;
    const replacer = new SafeReplacer(fs);

    let writer: PdfWriter;
    try {
      writer = await PdfWriter.open(data);
    } catch (e: any) {
      if (String(e?.message).includes('encrypted')) {
        throw new CropError('encrypted', '此 PDF 已加密，插件不会修改受保护的 PDF。', e);
      }
      throw new CropError('damaged', 'PDF 解析失败，原文件未做任何修改。', e);
    }
    const pageCount = writer.pageCount;
    const metadata = writer.getRestoreMetadata();
    if (!metadata) {
      throw new CropError('no-restore-data', '没有可恢复的原始页面信息。');
    }
    if (metadata.pages.length !== pageCount) {
      throw new CropError(
        'restore-mismatch',
        '已保存的原始页面信息与当前页数不符，无法恢复。'
      );
    }

    let changed = 0;
    for (let i = 0; i < pageCount; i++) {
      const current = writer.getPageBoxes(i);
      const saved = metadata.pages[i];
      // 比较「当前可见区域」与「原始可见区域」（crop 为 null 时等于 MediaBox）
      const curVisible = current.crop ?? current.media;
      const savedVisible = saved.crop ?? current.media;
      if (!boxesEqual(curVisible, savedVisible)) {
        writer.restorePageBoxes(i, { crop: saved.crop });
        changed++;
      }
    }
    if (changed === 0) {
      return { status: 'no-change', pageCount, changedPageCount: 0, message: '页面已是原始状态' };
    }

    const outBytes = await writer.save();
    await this.verifyOutput(outBytes, pageCount, null);

    let tempPath: string;
    try {
      tempPath = await replacer.stage(targetPath, outBytes);
    } catch (e) {
      throw new CropError('io', '写入临时文件失败，原文件未做任何修改。', e);
    }
    try {
      await replacer.replace(tempPath, targetPath);
    } catch (e) {
      await replacer.cleanup(tempPath);
      throw new CropError('io', '替换原文件失败，原文件未做任何修改。', e);
    }
    log.info(`Restored ${changed}/${pageCount} pages -> ${targetPath}`);
    return { status: 'restored', pageCount, changedPageCount: changed, message: 'PDF 原始页面已恢复' };
  }

  private async openPdf(data: Uint8Array, options: PdfOpenOptions): Promise<PdfDocumentHandle> {
    return openPdfDocument(data, options);
  }

  private async analyzeAllPages(
    pdfHandle: PdfDocumentHandle,
    writer: PdfWriter,
    pageCount: number,
    dpi: number,
    progress: NonNullable<CropRequest['onProgress']>,
    config: CropConfig
  ): Promise<PageAnalysis[]> {
    const analyses: PageAnalysis[] = [];
    const pixelOptions: PixelAnalyzeOptions = {
      blankFraction: config.blankAreaFraction,
    };
    for (let i = 0; i < pageCount; i++) {
      progress('analyzing', i + 1, pageCount);
      const boxes = writer.getPageBoxes(i);
      const rotation = writer.getPageRotation(i);
      const visibleBox = boxes.crop ?? boxes.media;
      let analysis: PageAnalysis;
      try {
        // 非嵌入字体页：渲染可能缺字导致内容盒漏检 → 标记失败（不裁剪，安全优先）
        if (config.requireEmbeddedFonts && writer.hasNonEmbeddedFont(i)) {
          log.debug(`Page ${i + 1} uses non-embedded fonts; marking as failed (safe)`);
          analysis = {
            pageIndex: i,
            mediaBox: boxes.media,
            cropBox: visibleBox,
            contentBox: null,
            rotation,
            isBlank: false,
            darkBackground: false,
            isOutlier: false,
            analysisFailed: true,
          };
        } else {
          const view = await pdfHandle.getView(i + 1);
          const rendered = await pdfHandle.renderPage(i + 1, dpi);
          // 渲染期间检测到字体数据缺失（文字未画出）→ 内容盒不可靠 → 该页不裁剪
          if (rendered.fontDataMissing) {
            log.debug(`Page ${i + 1} font data missing during render; marking as failed (safe)`);
            analysis = {
              pageIndex: i,
              mediaBox: boxes.media,
              cropBox: visibleBox,
              contentBox: null,
              rotation,
              isBlank: false,
              darkBackground: false,
              isOutlier: false,
              analysisFailed: true,
            };
            analyses.push(analysis);
            continue;
          }
          const px = analyzePagePixels(rendered, pixelOptions);
          // analyzePagePixels 已返回显示坐标（左下原点，y 向上，像素单位）：
          // 除以 scale 转为 pt 后，从显示坐标映射回未旋转 MediaBox 坐标
          const contentBox = px.contentBox
            ? contentBoxToMediaBoxCoords(
                {
                  left: px.contentBox.left / rendered.scale,
                  bottom: px.contentBox.bottom / rendered.scale,
                  right: px.contentBox.right / rendered.scale,
                  top: px.contentBox.top / rendered.scale,
                },
                view,
                rotation
              )
            : null;
          analysis = {
            pageIndex: i,
            mediaBox: boxes.media,
            cropBox: visibleBox,
            contentBox,
            rotation,
            isBlank: px.contentBox === null,
            darkBackground: px.backgroundGray < config.darkBackgroundGray,
            isOutlier: false,
            analysisFailed: false,
          };
        }
      } catch (e) {
        log.warn(`Page ${i + 1} analysis failed: ${(e as Error).message}`);
        analysis = {
          pageIndex: i,
          mediaBox: boxes.media,
          cropBox: visibleBox,
          contentBox: null,
          rotation,
          isBlank: false,
          darkBackground: false,
          isOutlier: false,
          analysisFailed: true,
        };
      }
      analyses.push(analysis);
    }
    return analyses;
  }

  /** 校验输出：重新解析，页数一致 + 裁剪框正确 */
  private async verifyOutput(
    bytes: Uint8Array,
    expectedPageCount: number,
    pageCrops: PageCrop[] | null
  ): Promise<void> {
    try {
      const writer = await PdfWriter.open(bytes);
      if (writer.pageCount !== expectedPageCount) {
        throw new Error(`page count mismatch: ${writer.pageCount} != ${expectedPageCount}`);
      }
      if (pageCrops) {
        for (const crop of pageCrops) {
          if (!crop.changed) continue;
          const actualBoxes = writer.getPageBoxes(crop.pageIndex);
          const actual = actualBoxes.crop ?? actualBoxes.media;
          if (!boxesEqual(actual, crop.cropBox)) {
            throw new Error(
              `page ${crop.pageIndex + 1} crop box mismatch: ${JSON.stringify(actual)}`
            );
          }
        }
      }
    } catch (e) {
      throw new CropError('validation', '输出 PDF 校验失败，原文件未做任何修改。', e);
    }
  }
}

export type { PageAnalysis, PageCrop };
