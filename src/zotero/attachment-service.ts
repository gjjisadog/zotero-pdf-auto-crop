/**
 * Zotero 附件服务（attachment-service）。
 *
 * 提供：选中项判定（仅单个 PDF 附件）、读取附件字节、文件信息校验。
 */
import { log } from '../utils/logger';

/** 插件可处理的最大 PDF 大小（256 MB，pdf-lib 全量加载的内存/稳定性上限） */
export const MAX_PDF_BYTES = 256 * 1024 * 1024;

export function isCropableItem(item: Zotero.Item): boolean {
  return item.isPDFAttachment();
}

/** 读取附件文件字节；校验存在性/大小/加密前不做（交给 crop-service） */
export async function readAttachmentBytes(item: Zotero.Item): Promise<Uint8Array> {
  const path = await item.getFilePathAsync();
  if (!path) {
    throw new Error(`附件文件不存在: ${item.getFilePath()}`);
  }
  const stat = await IOUtils.stat(path);
  if (stat.size > MAX_PDF_BYTES) {
    throw new Error('PDF 文件过大（超过 256 MB），无法安全处理');
  }
  if (stat.size === 0) {
    throw new Error('PDF 文件为空');
  }
  const data = await IOUtils.read(path);
  log.debug(`read attachment ${item.libraryKey}: ${stat.size} bytes`);
  return data;
}

export async function getAttachmentPath(item: Zotero.Item): Promise<string> {
  const path = await item.getFilePathAsync();
  if (!path) {
    throw new Error('附件文件不存在');
  }
  return path;
}
