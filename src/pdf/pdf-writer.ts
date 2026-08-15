/**
 * 页面盒读写封装（pdf-writer，基于 pdf-lib）。
 *
 * 职责：
 * - 加载（updateMetadata: false，加密 PDF 抛 EncryptedPDFError → 上层拒绝）；
 * - 读取/写入 MediaBox、CropBox、TrimBox、BleedBox、ArtBox；
 * - 写入/读取恢复元数据（委托 crop-metadata）；
 * - 保存（全量重写；内容流字节不变，annotation/outline 保留——技术调查已验证）。
 *
 * 裁剪策略：只写 CropBox（并同步已存在的 Trim/Bleed/Art），MediaBox 保持不变
 * （更保守：内容坐标与 MediaBox 完全不动）。
 */
import { PDFDocument, PDFName, PDFArray, type PDFPageLeaf } from 'pdf-lib';
import type { PageBox } from '../crop/bounding-box';
import { boxFromRect, boxToRect } from '../crop/bounding-box';
import {
  readRestoreMetadata,
  writeRestoreMetadata,
  type RestoreMetadata,
} from './crop-metadata';

export interface PageBoxes {
  media: PageBox;
  crop: PageBox;
  trim?: PageBox;
  bleed?: PageBox;
  art?: PageBox;
}

export class PdfWriter {
  private constructor(private readonly doc: PDFDocument) {}

  /** 加密 PDF 会抛出 EncryptedPDFError（pdf-lib） */
  static async open(bytes: Uint8Array): Promise<PdfWriter> {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return new PdfWriter(doc);
  }

  get pageCount(): number {
    return this.doc.getPageCount();
  }

  /** 页面旋转（0/90/180/270，顺时针） */
  getPageRotation(index: number): number {
    return this.doc.getPage(index).getRotation().angle as number;
  }

  private getPageNode(index: number): PDFPageLeaf {
    const page = this.doc.getPage(index);
    return (page as any).node as PDFPageLeaf;
  }

  private readOptionalBox(node: PDFPageLeaf, name: string): PageBox | undefined {
    const entry = node.get(PDFName.of(name));
    if (entry instanceof PDFArray) {
      const rect = entry.asRectangle();
      return boxFromRect(rect.x, rect.y, rect.width, rect.height);
    }
    return undefined;
  }

  getPageBoxes(index: number): PageBoxes {
    const page = this.doc.getPage(index);
    const media = boxFromRect(
      page.getMediaBox().x,
      page.getMediaBox().y,
      page.getMediaBox().width,
      page.getMediaBox().height
    );
    const cropRect = page.getCropBox(); // fallback MediaBox
    const crop = boxFromRect(cropRect.x, cropRect.y, cropRect.width, cropRect.height);
    const node = this.getPageNode(index);
    return {
      media,
      crop,
      trim: this.readOptionalBox(node, 'TrimBox'),
      bleed: this.readOptionalBox(node, 'BleedBox'),
      art: this.readOptionalBox(node, 'ArtBox'),
    };
  }

  /**
   * 写入裁剪框：CropBox 必须 ⊆ MediaBox（调用方已保证）。
   * 已存在的 TrimBox/BleedBox/ArtBox 同步为新值（保持打印/预览一致）。
   */
  setPageCrop(index: number, crop: PageBox): void {
    const page = this.doc.getPage(index);
    const r = boxToRect(crop);
    page.setCropBox(r.x, r.y, r.width, r.height);
    const node = this.getPageNode(index);
    if (node.get(PDFName.of('TrimBox')) instanceof PDFArray) {
      page.setTrimBox(r.x, r.y, r.width, r.height);
    }
    if (node.get(PDFName.of('BleedBox')) instanceof PDFArray) {
      page.setBleedBox(r.x, r.y, r.width, r.height);
    }
    if (node.get(PDFName.of('ArtBox')) instanceof PDFArray) {
      page.setArtBox(r.x, r.y, r.width, r.height);
    }
  }

  /** 恢复原始盒（MediaBox 与 CropBox 等） */
  restorePageBoxes(index: number, boxes: PageBoxes): void {
    const page = this.doc.getPage(index);
    const m = boxToRect(boxes.media);
    page.setMediaBox(m.x, m.y, m.width, m.height);
    const c = boxToRect(boxes.crop);
    page.setCropBox(c.x, c.y, c.width, c.height);
    const node = this.getPageNode(index);
    for (const name of ['TrimBox', 'BleedBox', 'ArtBox']) {
      const b = name === 'TrimBox' ? boxes.trim : name === 'BleedBox' ? boxes.bleed : boxes.art;
      if (node.get(PDFName.of(name)) instanceof PDFArray && b) {
        const r = boxToRect(b);
        if (name === 'TrimBox') page.setTrimBox(r.x, r.y, r.width, r.height);
        else if (name === 'BleedBox') page.setBleedBox(r.x, r.y, r.width, r.height);
        else page.setArtBox(r.x, r.y, r.width, r.height);
      }
    }
  }

  /** 读取恢复元数据（Info 键优先，XMP 兜底）；无则 null */
  getRestoreMetadata(): RestoreMetadata | null {
    return readRestoreMetadata(this.doc);
  }

  /**
   * 写入恢复元数据（Info 字典 + 无冲突时 XMP 双写）。
   * 仅首次裁剪时调用；再次裁剪前先读取，绝不覆盖原始盒（任务 §21）。
   */
  setRestoreMetadata(metadata: RestoreMetadata): void {
    writeRestoreMetadata(this.doc, metadata);
  }

  async save(): Promise<Uint8Array> {
    return this.doc.save({
      useObjectStreams: true,
      addDefaultPage: false,
      updateFieldAppearances: false,
    });
  }

  /** 数字签名检测：扫描原始字节中的 /ByteRange（所有签名必需） */
  static scanForDigitalSignature(bytes: Uint8Array): boolean {
    const needle = new Uint8Array([0x2f, 0x42, 0x79, 0x74, 0x65, 0x52, 0x61, 0x6e, 0x67, 0x65]); // /ByteRange
    outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (bytes[i + j] !== needle[j]) continue outer;
      }
      return true;
    }
    return false;
  }
}
