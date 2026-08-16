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
  /**
   * 3：每页保存「生效的原始 CropBox」（含继承，H2-1）与「是否直接声明过 CropBox」。
   * effectiveCrop: null = 无任何 CropBox（含继承），显示即 MediaBox；
   * hadDirectCrop: 页面节点自身是否直接写了 CropBox（恢复时决定 set 还是 delete）。
   */
  version: 3;
  plugin: 'zotero-pdf-auto-crop';
  createdAt: string;
  pages: { effectiveCrop: PageBox | null; hadDirectCrop: boolean }[];
}

export function createRestoreMetadata(
  pages: { effectiveCrop: PageBox | null; hadDirectCrop: boolean }[]
): RestoreMetadata {
  return {
    version: 3,
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
  // P1-3：严格校验——版本必须在 {1,2,3}，坐标必须有限且几何合法
  if (v.version !== 1 && v.version !== 2 && v.version !== 3) {
    return null;
  }
  const isValidBox = (b: any): b is PageBox =>
    !!b && typeof b === 'object' &&
    typeof b.left === 'number' && Number.isFinite(b.left) &&
    typeof b.bottom === 'number' && Number.isFinite(b.bottom) &&
    typeof b.right === 'number' && Number.isFinite(b.right) &&
    typeof b.top === 'number' && Number.isFinite(b.top) &&
    b.left < b.right &&
    b.bottom < b.top;
  const normalized: RestoreMetadata = {
    version: 3,
    plugin: 'zotero-pdf-auto-crop',
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : new Date().toISOString(),
    pages: [],
  };
  for (const p of v.pages) {
    // v1/v2 用 crop 字段；v3 用 effectiveCrop/hadDirectCrop
    const crop = v.version === 3 ? p.effectiveCrop : p.crop;
    if (crop !== null && crop !== undefined && !isValidBox(crop)) {
      return null;
    }
    normalized.pages.push({
      effectiveCrop: crop ?? null,
      hadDirectCrop: v.version === 3 ? !!p.hadDirectCrop : crop != null,
    });
  }
  return normalized;
}
