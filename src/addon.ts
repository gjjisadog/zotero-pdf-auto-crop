/**
 * 插件主类（addon）：生命周期 hooks 与模块接线。
 *
 * 注意：Zotero 插件环境没有 ES module 缓存语义，bundle 为 IIFE；
 * 模块间通过闭包与单例交互，不依赖全局状态。
 */
import { registerContextMenu, unregisterContextMenu, STANDARD_FONTS_URL } from './ui/context-menu';
import { appendOperationLog } from './zotero/operation-log';
import { useZoteroLogger, log } from './utils/logger';
import { CropService, type CropResult } from './crop/crop-service';
import type { CropConfig } from './crop/crop-model';
import { ZoteroFileSystem } from './utils/temp-file';
import { createDefaultCanvasBackend } from './pdf/pdf-reader';

export class Addon {
  /** bootstrap.js 调用的 hooks（模板约定：Zotero.ZoteroPdfAutoCrop.hooks.onStartup()） */
  hooks = {
    onStartup: () => this.onStartup(),
    onShutdown: () => this.onShutdown(),
    onMainWindowLoad: (win: unknown) => this.onMainWindowLoad(win),
    onMainWindowUnload: (win: unknown) => this.onMainWindowUnload(win),
  };

  /** 已注册的菜单 key（shutdown 时卸载） */
  private menuKeys: string[] = [];

  async onStartup(): Promise<void> {
    await Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise,
    ]);
    useZoteroLogger();
    log.info('starting up');

    // 条目右键菜单（V1 唯一入口）
    const keys = registerContextMenu();
    this.menuKeys = keys;

    // bootstrap 全局缺少部分 DOM 构造器（DOMException/Path2D/AbortController 等），
    // 从主窗口补齐（Path2D 等需与渲染 canvas 同 realm）
    this.patchMissingDOMGlobals();

    // 程序化自检入口（prefs 驱动，V2 自动裁剪的同一管线）：
    // extensions.zotero.zpac.debugCropPath / debugRestorePath 指向文件路径时执行
    await this.runPrefDrivenSelfTest();
  }

  /**
   * 从指定窗口（默认当前主窗口）复制 DOM 构造器到 bootstrap 全局。
   *
   * H2-4（第三轮 review）：realm 敏感对象（Path2D/DOMMatrix/ImageData 等）
   * 必须与渲染 canvas 同 realm。macOS 上关闭主窗口后应用进程继续运行、
   * 重新打开的是新窗口（新 realm）——因此主窗口变化时旧窗口的构造器会
   * 被新窗口覆盖（onMainWindowLoad 重新调用本方法）。
   *
   * 注意：仅覆盖「realm 敏感的 DOM 构造器」；基础字符串/编解码全局
   * （atob/btoa/TextEncoder 等）只在缺失时补齐——无条件覆盖会破坏
   * bootstrap 全局的既有绑定（实测：覆盖 atob 后 pdf.js 报
   * `t.charCodeAt is not a function`）。
   */
  private patchMissingDOMGlobals(win?: unknown): void {
    const G = globalThis as any;
    const w = (win ?? Zotero.getMainWindow?.()) as any;
    if (!w) return;
    // realm 敏感：Path2D/DOMMatrix/ImageData 必须与渲染 canvas 同 realm，
    // 主窗口变化时无条件刷新
    const realmSensitive = ['Path2D', 'DOMMatrix', 'ImageData'];
    // 缺失补齐：DOM 基础与流/网络（pdf.js 图像解码与字体加载需要）
    const missingOk = [
      'DOMException', 'AbortController', 'AbortSignal',
      'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
      'atob', 'btoa', 'structuredClone', 'Blob', 'FileReader',
      'ReadableStream', 'WritableStream', 'TransformStream',
      'CompressionStream', 'DecompressionStream',
      'fetch', 'Response', 'Request', 'Headers',
      'MessageChannel', 'MessagePort', 'BroadcastChannel',
      'Event', 'EventTarget', 'CustomEvent', 'crypto', 'performance',
    ];
    for (const name of realmSensitive) {
      if (typeof w[name] === 'undefined') continue;
      try {
        G[name] = w[name];
      } catch {
        // 个别构造器可能不可复制，忽略
      }
    }
    for (const name of missingOk) {
      if (typeof G[name] !== 'undefined' || typeof w[name] === 'undefined') continue;
      try {
        G[name] = w[name];
      } catch {
        // 个别构造器可能不可复制，忽略
      }
    }
  }

  async onMainWindowLoad(win: unknown): Promise<void> {
    // H2-4：主窗口重建（关闭后重开）时 realm 会变化，
    // 用新窗口的构造器重新刷新 DOM 全局，避免跨 realm 对象混用
    this.patchMissingDOMGlobals(win);
  }

  async onMainWindowUnload(_win: unknown): Promise<void> {}

  async onShutdown(): Promise<void> {
    log.info('shutting down');
    for (const key of this.menuKeys) {
      try {
        unregisterContextMenu(key);
      } catch (e) {
        log.error('failed to unregister menu', e);
      }
    }
    this.menuKeys = [];
  }

  /**
   * 程序化裁剪入口（文件路径）：与右键菜单共用同一 CropService（cropFile：
   * 稳定快照 + 原子替换）。亦为 V2「导入后自动裁剪 / 批量裁剪」的预留 API
   * （任务 §42–§43）。注意：仅供文件系统可直接访问的附件路径使用，
   * 不处理 Zotero item 状态。
   */
  async cropFile(path: string, config?: Partial<CropConfig>): Promise<CropResult> {
    log.info(`cropFile: ${path}`);
    const service = new CropService();
    const r = await service.cropFile({
      targetPath: path,
      fs: new ZoteroFileSystem(),
      pdfOptions: {
        standardFontDataUrl: STANDARD_FONTS_URL,
        canvasBackend: createDefaultCanvasBackend(),
      },
      config: { ...config },
    });
    await appendOperationLog({ action: 'crop', path, status: r.status, pageCount: r.pageCount, changed: r.changedPageCount, message: r.message });
    return r;
  }

  /** 程序化恢复入口（文件路径） */
  async restoreFile(path: string): Promise<CropResult> {
    log.info(`restoreFile: ${path}`);
    const service = new CropService();
    const r = await service.restoreFile({
      targetPath: path,
      fs: new ZoteroFileSystem(),
      pdfOptions: {
        standardFontDataUrl: STANDARD_FONTS_URL,
        canvasBackend: createDefaultCanvasBackend(),
      },
    });
    await appendOperationLog({ action: 'restore', path, status: r.status, pageCount: r.pageCount, changed: r.changedPageCount, message: r.message });
    return r;
  }

  /**
   * 操作日志：追加到 profile/zpac-operations.log（最近 500 行）。
   * 用于诊断实际使用中的问题（正常模式下 Zotero 无文件日志）。
   */
  /**
   * prefs 驱动的自检：设置 extensions.zotero.zpac.debugCropPath /
   * debugRestorePath / debugCropDir 后重启，插件自动对指定文件/目录执行
   * 裁剪/恢复并输出日志。用于自动化验证与 V2 自动裁剪的同一管线；
   * 执行后自动清除 prefs。
   */
  private async runPrefDrivenSelfTest(): Promise<void> {
    // Zotero.Prefs.get/set 自动加 extensions.zotero. 前缀
    const PREFIX = 'zpac.debug';
    let ran = false;
    try {
      const cropPaths = (Zotero.Prefs.get(`${PREFIX}CropPaths`) as string) ?? '';
      const restorePath = Zotero.Prefs.get(`${PREFIX}RestorePath`) as string;
      // 逗号分隔的文件列表（避免依赖 IOUtils.readDirectory）
      const paths = cropPaths.split(',').map((x) => x.trim()).filter(Boolean);
      for (const p of paths) {
        ran = true;
        log.info(`self-test crop: ${p}`);
        try {
          const r = await this.cropFile(p);
          log.info(`self-test crop result (${p}): ${JSON.stringify(r)}`);
        } catch (err) {
          log.error(`self-test crop failed (${p})`, err);
        }
      }
      if (restorePath) {
        ran = true;
        log.info(`self-test restore: ${restorePath}`);
        const r = await this.restoreFile(restorePath);
        log.info(`self-test restore result: ${JSON.stringify(r)}`);
      }
    } catch (e) {
      log.error('self-test failed', e);
    } finally {
      if (ran) {
        Zotero.Prefs.set(`${PREFIX}CropPaths`, '');
        Zotero.Prefs.set(`${PREFIX}RestorePath`, '');
      }
    }
  }
}
