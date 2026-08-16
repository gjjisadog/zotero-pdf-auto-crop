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
import { PDFDocument, PDFName, PDFArray, PDFDict, type PDFPageLeaf } from 'pdf-lib';
import type { PageBox } from '../crop/bounding-box';
import { boxFromRect, boxToRect } from '../crop/bounding-box';
import {
  readRestoreMetadata,
  writeRestoreMetadata,
  type RestoreMetadata,
} from './crop-metadata';

export interface PageBoxes {
  media: PageBox;
  /** 当前 CropBox；null = 页面原本没有 CropBox（显示即 MediaBox） */
  crop: PageBox | null;
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

  /**
   * 页面是否引用「非嵌入字体」（标准 14 字体或无 FontFile 流的字体）。
   * 此类字体在渲染环境缺字体数据时不会画出，导致内容盒漏检 → 该页应标记
   * 分析失败（不裁剪，安全优先）。Type3 字体自包含，不算。
   */
  hasNonEmbeddedFont(index: number): boolean {
    const page = this.doc.getPage(index);
    const resources = (page.node as any).Resources();
    if (!(resources instanceof PDFDict)) return false;
    const fontDict = resources.get(PDFName.of('Font'));
    if (!(fontDict instanceof PDFDict)) return false;
    for (const name of fontDict.keys()) {
      const font = this.doc.context.lookup(fontDict.get(name));
      if (!(font instanceof PDFDict)) continue;
      if (font.get(PDFName.of('Subtype')) instanceof PDFName
        && font.get(PDFName.of('Subtype')) === PDFName.of('Type3')) {
        continue; // Type3 自包含字形
      }
      const desc = font.get(PDFName.of('FontDescriptor'));
      const descDict = desc ? this.doc.context.lookup(desc) : undefined;
      if (!(descDict instanceof PDFDict)) {
        return true; // 无 FontDescriptor = 未嵌入
      }
      if (!descDict.get(PDFName.of('FontFile'))
        && !descDict.get(PDFName.of('FontFile2'))
        && !descDict.get(PDFName.of('FontFile3'))) {
        return true; // 有描述符但无字体文件流 = 未嵌入
      }
    }
    return false;
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

  /** 页面是否显式设置了 CropBox（含继承） */
  hasCropBox(index: number): boolean {
    const node = this.getPageNode(index);
    return node.get(PDFName.of('CropBox')) instanceof PDFArray;
  }

  getPageBoxes(index: number): PageBoxes {
    const page = this.doc.getPage(index);
    const media = boxFromRect(
      page.getMediaBox().x,
      page.getMediaBox().y,
      page.getMediaBox().width,
      page.getMediaBox().height
    );
    const node = this.getPageNode(index);
    const crop = this.hasCropBox(index)
      ? (() => {
          const r = page.getCropBox();
          return boxFromRect(r.x, r.y, r.width, r.height);
        })()
      : null;
    return {
      media,
      crop,
      trim: this.readOptionalBox(node, 'TrimBox'),
      bleed: this.readOptionalBox(node, 'BleedBox'),
      art: this.readOptionalBox(node, 'ArtBox'),
    };
  }

  /**
   * 写入裁剪框（P1-1：只写 CropBox，不碰 MediaBox/TrimBox/BleedBox/ArtBox——
   * 后者是印刷语义，阅读插件无理由修改）。
   * crop 为 null 表示删除 CropBox（恢复"原本无 CropBox"的状态）。
   * CropBox 必须 ⊆ MediaBox（调用方已保证）。
   */
  setPageCrop(index: number, crop: PageBox | null): void {
    const node = this.getPageNode(index);
    if (crop === null) {
      node.delete(PDFName.of('CropBox'));
      return;
    }
    const page = this.doc.getPage(index);
    const r = boxToRect(crop);
    page.setCropBox(r.x, r.y, r.width, r.height);
  }

  /** 恢复原始可见状态（P1-1：只恢复 CropBox；其他盒从未被修改） */
  restorePageBoxes(index: number, saved: { crop: PageBox | null }): void {
    this.setPageCrop(index, saved.crop);
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
