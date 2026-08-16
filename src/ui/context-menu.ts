/**
 * 条目右键菜单（context-menu）—— V1 唯一操作入口（任务 §4）。
 *
 * 使用 Zotero 7+ 官方 API：Zotero.MenuManager.registerMenu
 * （target: 'main/library/item'；context.items 为选中项）。
 *
 * 显示规则：
 * - 恰好选中 1 个 PDF 附件 → 显示「自动裁剪 PDF 白边」「恢复原始页面」；
 * - 其他选择（父条目/文件夹/网页附件/EPUB/图片…）→ 隐藏；
 * - 恢复菜单的可用性取决于 PDF 内是否保存了本插件的恢复元数据（异步判定）。
 *
 * 执行流程（任务 §55）：读取原始盒 → 分析 → 稳定裁剪框 → 写临时文件 →
 * 校验 → 原子替换 → reload Reader → 通知 Sync → 完成提示。
 */
import { CropService, CropError } from '../crop/crop-service';
import { ZoteroFileSystem } from '../utils/temp-file';
import { createDefaultCanvasBackend } from '../pdf/pdf-reader';
import { PdfWriter } from '../pdf/pdf-writer';
import { isCropableItem, readAttachmentBytes, getAttachmentPath } from '../zotero/attachment-service';
import { reloadReadersForItem } from '../zotero/reader-service';
import { notifyAttachmentFileChanged } from '../zotero/sync-service';
import { createProgressWindow, type ProgressHandle } from '../zotero/progress';
import { appendOperationLog } from '../zotero/operation-log';
import { log } from '../utils/logger';

/** 插件 ID（与 manifest applications.zotero.id 一致） */
export const ADDON_ID = 'zotero-pdf-auto-crop@zotero.org';

/** 打包进 XPI 并经 bootstrap registerChrome 注册的 standard fonts 资源 */
export const STANDARD_FONTS_URL = 'chrome://zotero-pdf-auto-crop/content/standard_fonts/';

const MENU_ID = 'zpac-item-menu';
const CROP_ITEM_ID = 'zpac-crop-item';
const RESTORE_ITEM_ID = 'zpac-restore-item';

export function registerContextMenu(): string[] {
  const key = Zotero.MenuManager.registerMenu({
    menuID: MENU_ID,
    pluginID: ADDON_ID,
    target: 'main/library/item',
    menus: [
      {
        menuType: 'menuitem',
        onShowing: (event: unknown, context: any) => {
          const visible = isSinglePdfAttachment(context);
          context.setVisible(visible);
          if (visible) {
            context.menuElem.label = '自动裁剪 PDF 白边';
          }
        },
        onCommand: (event: unknown, context: any) => {
          runWithSinglePdf(context, 'crop');
        },
      },
      {
        menuType: 'menuitem',
        onShowing: (event: unknown, context: any) => {
          const visible = isSinglePdfAttachment(context);
          context.setVisible(visible);
          if (!visible) return;
          context.menuElem.label = '恢复原始页面';
          // 异步判定：PDF 内是否保存了恢复元数据
          void updateRestoreEnabled(context);
        },
        onCommand: (event: unknown, context: any) => {
          runWithSinglePdf(context, 'restore');
        },
      },
    ],
  });
  if (!key) {
    log.error('failed to register context menu');
    return [];
  }
  // registerMenu 返回单个 key（菜单整体）
  log.info(`context menu registered: ${key}`);
  return [key];
}

export function unregisterContextMenu(key: string): void {
  Zotero.MenuManager.unregisterMenu(key);
}

function isSinglePdfAttachment(context: any): boolean {
  const items: Zotero.Item[] = context?.items;
  if (!Array.isArray(items) || items.length !== 1) return false;
  const item = items[0];
  try {
    return isCropableItem(item);
  } catch {
    return false;
  }
}

/** 异步更新恢复菜单 enabled（读 PDF 元数据；失败保持 enabled，点击时再提示） */
async function updateRestoreEnabled(context: any): Promise<void> {
  const item: Zotero.Item = context.items[0];
  try {
    const path = await getAttachmentPath(item);
    const stat = await IOUtils.stat(path);
    if (stat.size > 64 * 1024 * 1024) {
      return; // 大文件跳过快速判定，保持 enabled
    }
    const data = await IOUtils.read(path);
    const writer = await PdfWriter.open(data);
    const hasRestore = writer.getRestoreMetadata() !== null;
    context.setEnabled(hasRestore);
  } catch {
    // 静默失败：保持 enabled，点击时给出明确提示
  }
}

/** 防重入 */
let running = false;

async function runWithSinglePdf(context: any, action: 'crop' | 'restore'): Promise<void> {
  if (running) return;
  const item: Zotero.Item = context.items[0];
  running = true;
  let progress: ProgressHandle | null = null;
  try {
    progress = createProgressWindow(action === 'crop' ? '自动裁剪 PDF 白边' : '恢复原始页面');
    const path = await getAttachmentPath(item);
    const data = await readAttachmentBytes(item);
    await appendOperationLog({ action, itemKey: item.libraryKey, path, stage: 'start' });
    const service = new CropService();

    if (action === 'crop') {
      const result = await service.cropPdf({
        data,
        targetPath: path,
        fs: new ZoteroFileSystem(),
        pdfOptions: { standardFontDataUrl: STANDARD_FONTS_URL, canvasBackend: createDefaultCanvasBackend() },
        onProgress: (stage, page, total) => {
          const label =
            stage === 'analyzing' ? `正在分析 PDF… 第 ${page}/${total} 页`
            : stage === 'applying' ? `正在应用裁剪… 第 ${page}/${total} 页`
            : stage === 'saving' ? '正在保存…'
            : '正在校验…';
          progress?.setText(label);
          progress?.setPercent(total > 0 ? (page / total) * 100 : 100);
        },
      });

      if (result.status === 'cropped') {
        await afterFileReplaced(item);
        progress?.setText(`裁剪完成：${result.changedPageCount}/${result.pageCount} 页`);
        progress?.done();
        log.info(`cropped ${item.libraryKey}: ${result.changedPageCount}/${result.pageCount} pages`);
        await appendOperationLog({ action, itemKey: item.libraryKey, path, stage: 'done', status: result.status, pageCount: result.pageCount, changed: result.changedPageCount, message: result.message });
      } else if (result.status === 'no-change') {
        progress?.setText('未检测到需要裁剪的白边');
        progress?.done();
        await appendOperationLog({ action, itemKey: item.libraryKey, path, stage: 'done', status: result.status, pageCount: result.pageCount, message: result.message });
      }
    } else {
      const result = await service.restorePdf({
        data,
        targetPath: path,
        fs: new ZoteroFileSystem(),
        pdfOptions: { standardFontDataUrl: STANDARD_FONTS_URL, canvasBackend: createDefaultCanvasBackend() },
        onProgress: (stage, page, total) => {
          progress?.setText(`正在恢复… 第 ${page}/${total} 页`);
          progress?.setPercent(total > 0 ? (page / total) * 100 : 100);
        },
      });
      if (result.status === 'restored') {
        await afterFileReplaced(item);
        progress?.setText(`恢复完成：${result.changedPageCount}/${result.pageCount} 页`);
        progress?.done();
        await appendOperationLog({ action, itemKey: item.libraryKey, path, stage: 'done', status: result.status, pageCount: result.pageCount, changed: result.changedPageCount, message: result.message });
      } else if (result.status === 'no-change') {
        progress?.setText('页面已是原始状态');
        progress?.done();
        await appendOperationLog({ action, itemKey: item.libraryKey, path, stage: 'done', status: result.status, message: result.message });
      }
    }
  } catch (e) {
    progress?.close();
    if (e instanceof CropError) {
      log.warn(`crop failed (${e.kind}): ${e.message}`);
      alertError(e.message);
      await appendOperationLog({ action, itemKey: item.libraryKey, stage: 'error', kind: e.kind, message: e.message });
    } else if (e instanceof Error) {
      log.error('operation failed', e);
      alertError(`操作失败：${e.message}\n\n原 PDF 未被修改。`);
      await appendOperationLog({ action, itemKey: item.libraryKey, stage: 'error', message: e.message });
    } else {
      alertError('操作失败：未知错误。\n\n原 PDF 未被修改。');
      await appendOperationLog({ action, itemKey: item.libraryKey, stage: 'error', message: String(e) });
    }
  } finally {
    running = false;
  }
}

/** 文件替换成功后：刷新 Reader + 通知 Sync + 更新附件信息 */
async function afterFileReplaced(item: Zotero.Item): Promise<void> {
  // Reader 重读磁盘文件（保留页码/缩放）；私有 API 不可用时提示用户重开
  const reload = await reloadReadersForItem(item.id);
  if (!reload.available) {
    alertError('已裁剪完成，但无法自动刷新打开的阅读器，请重新打开 PDF 查看裁剪结果。');
  }
  // 让 Zotero 感知附件文件已变化（sync 由 Zotero 自动检测并上传）
  await notifyAttachmentFileChanged(item);
  // 附件信息缓存刷新（完整索引/修改时间由 Zotero 自身检测）
  try {
    await (item as any).reload?.();
  } catch {
    // 忽略：不是所有状态都需要 reload
  }
}

function alertError(message: string): void {
  try {
    const win = Zotero.getMainWindow() as any;
    Zotero.alert(win, 'Zotero PDF Auto Crop', message);
  } catch {
    // 无主窗口时静默
  }
}
