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
 * 数据安全（H1-2 / H1-3，第三轮 review）：
 * - 生产入口 cropFile / restoreFile 由 PdfFileTransaction 完成
 *   「stat1 → read → stat2」稳定快照，data 与 targetPath 不再作为两个
 *   独立参数进入事务核心；
 * - 替换前再次校验源文件指纹（size + mtime），被其他程序修改则中止；
 * - crop 与 restore 都做数字签名预检（恢复也不会重写已签名 PDF）。
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
import type { FileSystem, FileStats } from '../utils/temp-file';
import { PdfFileTransaction } from './file-transaction';
import { CropError, type CropErrorKind } from './crop-error';
import { log } from '../utils/logger';
import { boxesEqual, clampBox, boxIntersect } from '../crop/bounding-box';

export type { CropErrorKind };
export { CropError };

export type CropStatus = 'cropped' | 'no-change' | 'restored';

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
  /** 原文件字节（已由调用方读取；H1-2：显式 data 仅用于测试/批处理注入） */
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
  /**
   * 与 data 对应的源文件指纹（cropFile/restoreFile 稳定快照提供）。
   * 缺省时本服务在替换前自取一次 stat 作为替换校验基准。
   */
  knownSourceStat?: FileStats;
}

/** cropFile / restoreFile 请求：只给路径，读取与校验由事务层完成（H1-2） */
export interface CropFileRequest {
  targetPath: string;
  fs: FileSystem;
  pdfOptions: PdfOpenOptions;
  config?: Partial<CropConfig>;
  dpi?: number;
  onProgress?: CropRequest['onProgress'];
}

export class CropService {
  /**
   * 生产入口：路径 → 稳定快照（stat1→read→stat2）→ 裁剪 → 原子替换。
   * data 与 targetPath 不再分离进入事务核心（H1-2）。
   */
  async cropFile(request: CropFileRequest): Promise<CropResult> {
    const txn = new PdfFileTransaction(request.fs, request.targetPath);
    const snap = await txn.acquireStableSnapshot();
    return this.cropPdf({
      data: snap.data,
      targetPath: request.targetPath,
      fs: request.fs,
      pdfOptions: request.pdfOptions,
      config: request.config,
      dpi: request.dpi,
      onProgress: request.onProgress,
      knownSourceStat: snap.stat,
    });
  }

  async cropPdf(request: CropRequest): Promise<CropResult> {
    const config: CropConfig = { ...DEFAULT_CROP_CONFIG, ...request.config };
    const dpi = request.dpi ?? ANALYSIS_DPI;
    // 统一归一化输入字节：调用方可能传入其他 realm 的 TypedArray
    const data = new Uint8Array(request.data);
    const { targetPath, fs, pdfOptions } = request;
    const progress = request.onProgress ?? (() => {});
    const txn = new PdfFileTransaction(fs, targetPath);

    // 0. H1：记录源文件指纹（size + mtime）；替换前必须一致，
    //    否则处理期间（可能数十秒/数百页）被其他程序修改的版本会被旧版覆盖。
    //    显式 data 注入（测试/批处理）时由调用方提供 knownSourceStat，
    //    否则在本服务内先取一次。
    let beforeStat: FileStats;
    if (request.knownSourceStat) {
      beforeStat = request.knownSourceStat;
    } else {
      try {
        beforeStat = await fs.stat(targetPath);
      } catch (e) {
        throw new CropError('io', '无法读取原 PDF 文件状态。', e);
      }
    }

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
      restoreMetadata = createRestoreMetadata(
        boxes.map((b, idx) => ({
          effectiveCrop: b.crop,
          hadDirectCrop: writer.hasDirectCropBox(idx),
        }))
      );
    }

    // 4. 逐页渲染分析。
    // H2-1（上一轮）：重新裁剪必须基于「原始可见区域」分析，而不是当前 CropBox。
    // H2-3（上一轮）：只有「重新裁剪」才需要生成恢复原始 CropBox 的分析副本；
    // 首次裁剪时原文件就是 Original View，直接分析原输入（避免大文件双倍内存）。
    let analysisData: Uint8Array = data;
    if (existing) {
      const analysisWriter = await PdfWriter.open(data);
      for (let i = 0; i < pageCount; i++) {
        analysisWriter.setPageCrop(i, restoreMetadata.pages[i].effectiveCrop);
      }
      analysisData = await analysisWriter.save();
    }
    let analyses: PageAnalysis[];
    {
      const pdfHandle = await this.openPdf(analysisData, pdfOptions);
      try {
        analyses = await this.analyzeAllPages(pdfHandle, writer, pageCount, dpi, progress, config, restoreMetadata);
      } finally {
        // 分析完成即释放 pdf.js 文档，降低大书处理的内存峰值（H2-3）
        pdfHandle.destroy();
      }
    }
    {
      // 5. 布局 + 稳定化

      const layout = analyzeLayout(analyses, config);
      const pageCrops = computePageCrops(analyses, layout, config);

      // 初步判断：没有任何页需要变化则直接返回（不写文件）
      if (pageCrops.every((c) => !c.changed)) {
        log.info('No crop needed for any page');
        return {
          status: 'no-change',
          pageCount,
          changedPageCount: 0,
          pageCrops,
          message: '未检测到明显白边，页面未做修改（内容已接近页面边缘，或页面使用了无法安全分析的字体）',
        };
      }

      // 6. 最终裁剪框 + 重算 changed（P1-2）。
      // H2-2：最终 CropBox 必须 ⊆ 原始可见区域 = Original effectiveCrop ∩ MediaBox
      //（CropBox 超出 MediaBox 的不规范 PDF 也绝不 reveal 原来看不到的内容）。
      let changedCount = 0;
      for (const crop of pageCrops) {
        const boxes = writer.getPageBoxes(crop.pageIndex);
        const currentVisible = boxes.crop ?? boxes.media;
        const saved = restoreMetadata.pages[crop.pageIndex];
        const baseVisible = saved.effectiveCrop
          ? (boxIntersect(saved.effectiveCrop, boxes.media) ?? boxes.media)
          : boxes.media;
        const finalCrop = clampBox(crop.cropBox, baseVisible);
        const changed = !boxesEqual(finalCrop, currentVisible);
        if (changed && !boxesEqual(finalCrop, crop.cropBox)) {
          log.debug(`page ${crop.pageIndex + 1}: crop clamped to original visible box`);
        }
        crop.cropBox = finalCrop;
        crop.changed = changed;
        if (changed) changedCount++;
      }
      if (changedCount === 0) {
        // clamp 后实际无变化：不重写文件（避免无意义的 rewrite 与 sync 上传）
        return {
          status: 'no-change',
          pageCount,
          changedPageCount: 0,
          pageCrops,
          message: '未检测到需要调整的白边（裁剪结果与当前页面一致）',
        };
      }
      for (const crop of pageCrops) {
        if (crop.changed) {
          writer.setPageCrop(crop.pageIndex, crop.cropBox);
          progress('applying', crop.pageIndex + 1, pageCount);
        }
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

      // 9. 原子替换（写临时文件 → 替换前指纹校验 → 单次 move）
      await txn.atomicReplace(outBytes, beforeStat);

      log.info(`Cropped ${changedCount}/${pageCount} pages -> ${targetPath}`);
      return {
        status: 'cropped',
        pageCount,
        changedPageCount: changedCount,
        pageCrops,
        message: 'PDF 白边裁剪完成',
      };
    }
  }

  /**
   * 生产入口：路径 → 稳定快照 → 恢复 → 原子替换（H1-3：
   * restore 与 crop 同等的数据安全保护）。
   */
  async restoreFile(request: Omit<CropFileRequest, 'dpi' | 'config'>): Promise<CropResult> {
    const txn = new PdfFileTransaction(request.fs, request.targetPath);
    const snap = await txn.acquireStableSnapshot();
    return this.restorePdf({
      data: snap.data,
      targetPath: request.targetPath,
      fs: request.fs,
      pdfOptions: request.pdfOptions,
      onProgress: request.onProgress,
      knownSourceStat: snap.stat,
    });
  }

  async restorePdf(request: Omit<CropRequest, 'dpi'>): Promise<CropResult> {
    const data = new Uint8Array(request.data);
    const { targetPath, fs, pdfOptions } = request;
    const txn = new PdfFileTransaction(fs, targetPath);

    let beforeStat: FileStats;
    if (request.knownSourceStat) {
      beforeStat = request.knownSourceStat;
    } else {
      try {
        beforeStat = await fs.stat(targetPath);
      } catch (e) {
        throw new CropError('io', '无法读取原 PDF 文件状态。', e);
      }
    }

    // H1-3：恢复同样拒绝已签名 PDF（重写会使签名失效）
    if (PdfWriter.scanForDigitalSignature(data)) {
      throw new CropError(
        'signed',
        '此 PDF 包含数字签名，修改 PDF 会使签名失效，因此插件未执行恢复。'
      );
    }

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

    // H2-3：恢复判断同时比较「有效几何」与「直接/继承结构状态」——
    // 即使当前可见区域数值与原始完全一致，只要结构不同（原本继承、
    // 现在被插件写成直接 CropBox）也必须恢复结构。
    let changed = 0;
    for (let i = 0; i < pageCount; i++) {
      const current = writer.getPageBoxes(i);
      const saved = metadata.pages[i];
      // 比较「当前可见区域」与「原始可见区域」（effectiveCrop 为 null 时等于 MediaBox）
      const curVisible = current.crop ?? current.media;
      const savedVisible = saved.effectiveCrop ?? current.media;
      const directNow = writer.hasDirectCropBox(i);
      const needsRestore =
        !boxesEqual(curVisible, savedVisible) || directNow !== saved.hadDirectCrop;
      if (needsRestore) {
        // H2-1：原本直接声明过 CropBox → 恢复原值；否则删除插件写入的 CropBox，
        // 恢复对父节点 CropBox 的继承
        writer.setPageCrop(i, saved.hadDirectCrop ? saved.effectiveCrop : null);
        changed++;
      }
    }
    if (changed === 0) {
      return { status: 'no-change', pageCount, changedPageCount: 0, message: '页面已是原始状态' };
    }

    const outBytes = await writer.save();
    await this.verifyOutput(outBytes, pageCount, null);

    // 原子替换（与 crop 同一事务层：临时文件 → 指纹校验 → 单次 move）
    await txn.atomicReplace(outBytes, beforeStat);
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
    config: CropConfig,
    restoreMetadata: RestoreMetadata
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
      // P1-1：原始可见区域 = 恢复的 effectiveCrop ∩ MediaBox（CropBox 超出
      // MediaBox 的不规范 PDF 也不 reveal 原来看不到的内容）
      const saved = restoreMetadata.pages[i];
      const originalVisibleBox = saved.effectiveCrop
        ? (boxIntersect(saved.effectiveCrop, boxes.media) ?? boxes.media)
        : boxes.media;
      let analysis: PageAnalysis;
      try {
        // 非嵌入字体页：渲染可能缺字导致内容盒漏检 → 标记失败（不裁剪，安全优先）
        if (config.requireEmbeddedFonts && writer.hasNonEmbeddedFont(i)) {
          log.debug(`Page ${i + 1} uses non-embedded fonts; marking as failed (safe)`);
          analysis = {
            pageIndex: i,
            mediaBox: boxes.media,
            cropBox: visibleBox,
            originalVisibleBox,
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
              originalVisibleBox,
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
            originalVisibleBox,
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
          originalVisibleBox,
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
