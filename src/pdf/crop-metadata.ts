/**
 * 恢复元数据编码/解码（crop-metadata）。
 *
 * 存储位置（双写，任务 §20）：
 * 1. Info 字典自定义键 `ZoteroPdfAutoCropRestore`（JSON 字符串，简单可靠，
 *    参考 pdfCropMargins 的 Info 键思路，但使用本插件独立命名空间）；
 * 2. XMP 自定义命名空间 `https://github.com/zotero-pdf-auto-crop#`（仅当 PDF
 *    原本没有 /Metadata 流时写入，避免覆盖其他工具的 XMP）。
 *
 * 读取优先级：Info 键 → XMP。
 * 多次裁剪语义：读取到已有元数据即复用，绝不覆盖（任务 §21）。
 */
import { PDFName, PDFString, PDFDict, PDFStream, decodePDFRawStream, PDFDocument } from 'pdf-lib';
import type { PageBox } from '../crop/bounding-box';

export const RESTORE_INFO_KEY = 'ZoteroPdfAutoCropRestore';
export const RESTORE_XMP_NS = 'https://github.com/gjjisadog/zotero-pdf-auto-crop#';
const RESTORE_XMP_TAG = 'zpac:originalBoxes';

export interface RestoreMetadata {
  /** 2：仅保存每页原始 CropBox（crop 可为 null = 原本无 CropBox；P1-1 只写 CropBox） */
  version: 2;
  plugin: 'zotero-pdf-auto-crop';
  createdAt: string;
  pages: { crop: PageBox | null }[];
}

export function createRestoreMetadata(
  pages: { crop: PageBox | null }[]
): RestoreMetadata {
  return {
    version: 2,
    plugin: 'zotero-pdf-auto-crop',
    createdAt: new Date().toISOString(),
    pages,
  };
}

// ---------- Info 字典 ----------

function getInfoDict(doc: PDFDocument): PDFDict | null {
  const ref = doc.context.trailerInfo.Info;
  if (!ref) return null;
  const obj = doc.context.lookup(ref);
  return obj instanceof PDFDict ? obj : null;
}

export function readRestoreFromInfo(doc: PDFDocument): RestoreMetadata | null {
  const info = getInfoDict(doc);
  if (!info) return null;
  const entry = info.get(PDFName.of(RESTORE_INFO_KEY));
  if (!(entry instanceof PDFString)) return null;
  try {
    const parsed = JSON.parse(entry.decodeText());
    return validateRestoreMetadata(parsed);
  } catch {
    return null;
  }
}

export function writeRestoreToInfo(doc: PDFDocument, metadata: RestoreMetadata): void {
  let info = getInfoDict(doc);
  if (!info) {
    info = doc.context.obj({}) as PDFDict;
    doc.context.trailerInfo.Info = doc.context.register(info);
  }
  info.set(PDFName.of(RESTORE_INFO_KEY), PDFString.of(JSON.stringify(metadata)));
}

// ---------- XMP ----------

function buildXmpPacket(base64Json: string): string {
  return (
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    `<rdf:Description rdf:about="" xmlns:zpac="${RESTORE_XMP_NS}">` +
    `<${RESTORE_XMP_TAG}>${base64Json}</${RESTORE_XMP_TAG}>` +
    '</rdf:Description>' +
    '</rdf:RDF>' +
    '</x:xmpmeta>' +
    '<?xpacket end="w"?>'
  );
}

function extractBase64FromXmp(xmp: string): string | null {
  const m = xmp.match(new RegExp(`<${RESTORE_XMP_TAG}>([^<]*)</${RESTORE_XMP_TAG}>`));
  return m ? m[1] : null;
}

function readRestoreFromXmp(doc: PDFDocument): RestoreMetadata | null {
  const metadataRef = doc.catalog.get(PDFName.of('Metadata'));
  if (!metadataRef) return null;
  const stream = doc.context.lookup(metadataRef);
  if (!(stream instanceof PDFStream)) return null;
  const raw = stream as any;
  let bytes: Uint8Array;
  try {
    const decoded = decodePDFRawStream(raw);
    bytes = new Uint8Array((decoded as any).bytes ?? decoded);
  } catch {
    return null;
  }
  const text = new TextDecoder().decode(bytes);
  const base64 = extractBase64FromXmp(text);
  if (!base64) return null;
  try {
    const json = atob(base64);
    const parsed = JSON.parse(json);
    return validateRestoreMetadata(parsed);
  } catch {
    return null;
  }
}

/** 写 XMP（仅当 PDF 原本没有 /Metadata 流，避免覆盖现有 XMP） */
function writeRestoreToXmp(doc: PDFDocument, metadata: RestoreMetadata): boolean {
  if (doc.catalog.get(PDFName.of('Metadata'))) {
    return false; // 已有 XMP，不覆盖
  }
  const base64 = btoa(JSON.stringify(metadata));
  const stream = doc.context.stream(new TextEncoder().encode(buildXmpPacket(base64)), {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
  return true;
}

// ---------- 公共入口 ----------

export function readRestoreMetadata(doc: PDFDocument): RestoreMetadata | null {
  return readRestoreFromInfo(doc) ?? readRestoreFromXmp(doc);
}

export function writeRestoreMetadata(doc: PDFDocument, metadata: RestoreMetadata): void {
  writeRestoreToInfo(doc, metadata);
  writeRestoreToXmp(doc, metadata);
}

function validateRestoreMetadata(value: unknown): RestoreMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as any;
  if (v.plugin !== 'zotero-pdf-auto-crop' || !Array.isArray(v.pages)) {
    return null;
  }
  const isValidBox = (b: any) =>
    b && typeof b === 'object' &&
    typeof b.left === 'number' && typeof b.bottom === 'number' &&
    typeof b.right === 'number' && typeof b.top === 'number';
  for (const p of v.pages) {
    if (p.crop !== null && !isValidBox(p.crop)) return null;
  }
  // 接受 version 1（旧格式含 media/trim 等，仅用其 crop 字段）与 version 2
  const normalized: RestoreMetadata = {
    version: 2,
    plugin: 'zotero-pdf-auto-crop',
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : new Date().toISOString(),
    pages: v.pages.map((p: any) => ({ crop: p.crop ?? null })),
  };
  return normalized;
}
