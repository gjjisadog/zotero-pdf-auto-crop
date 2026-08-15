# Zotero PDF Auto Crop — 技术调查报告（Phase 1）

> 调查时间：2026-08-15
> 调查对象：Zotero 当前稳定版（Zotero 7.x）、Zotero 7 插件 API、PDF Reader 架构、
> 附件文件更新/同步机制、`abarker/pdfCropMargins`（算法参考，GPL-3.0）、`pdf-lib`（PDF 写入引擎候选）。
> 本报告中的 API 事实均来自 Zotero 官方源码（`zotero/zotero` master 分支、
> `zotero/reader`、`zotero/document-worker` 子模块）原文引证，不是凭经验猜测。

---

## 0. 结论摘要

1. **Zotero 7 是当前稳定版**，插件基于 `manifest.json` + `bootstrap.js` 的现代架构，运行在
   Firefox 风格的特权环境中；**不存在**旧版 Zotero 6 的 `Zotero.Menu` XUL API。
2. **Zotero 没有暴露任何 PDF 渲染 API 给插件**：`Zotero.PDF` 在 Zotero 7 中不存在，pdf.js 完全
   内嵌于 Reader iframe（`resource://zotero/reader/`）与 `document-worker` 中。插件要做
   像素级白边检测，**必须自带一份 pdf.js（pdfjs-dist）并打包进 XPI** —— 这是"经过证明的必要依赖"。
3. **Zotero 内置 PDF 修改引擎（`Zotero.PDFWorker` + document-worker）不支持修改
   MediaBox/CropBox**（只支持 rotatePages / deletePages / annotations / fulltext 等固定动作）。
   修改页面边界需要一个 PDF 写入库：**选用 `pdf-lib`（MIT，纯 JS，无原生依赖）打包进 XPI**。
4. **修改 CropBox/MediaBox 不改变任何页面内容坐标**，因此 Zotero Annotation（存于本地数据库，
   坐标为 PDF 页面坐标系）**不受影响**；PDF 内嵌 annotation/outline/链接等对象也由 pdf-lib
   原样保留（详见 §5）。
5. **文件替换与同步**：Reader 通过 `zotero://attachment/` 协议按需从磁盘读文件，不持有长期
   文件锁；`reader.reload()` 会重读磁盘并**保留页码/滚动/缩放**。Zotero Sync 在每次同步时
   自动比较磁盘文件 mtime/MD5 与数据库记录（`storageModTime`/`storageHash`），文件变化即
   自动上传——**插件无需（也不应）手动写同步状态**。
6. **算法路线**：低分辨率渲染 → 背景估计 + 阈值二值化 → 行扫描噪声过滤 → 每页 content bbox
   → 页面分组（页面尺寸/旋转 + 奇偶自动识别）→ 异常页过滤 → 组内稳定裁剪框 → +2 mm 安全边距
   → 写入 CropBox（并同步 TrimBox/BleedBox/ArtBox）。恢复数据嵌入 PDF 内部（Info 字典 +
   XMP），不产生任何备份附件文件。
7. **许可**：算法参考 `pdfCropMargins`（GPL-3.0-or-later），但本插件**独立实现**，不复制其
   源码；插件采用 MIT 许可，无 GPL 传染。

---

## 1. 当前 Zotero 版本与插件架构

### 1.1 版本

Zotero 7.x 为当前稳定版（Zotero 7 于 2024 年 8 月发布，取代 Zotero 6；6 已停止维护）。
插件 manifest 中声明 `"strict_min_version": "7.0"` 即可锁定 Zotero 7+。

### 1.2 插件包结构（Zotero 7）

XPI 本质是一个 zip，包含：

```
manifest.json          # 插件清单（见下）
bootstrap.js           # 生命周期入口（install/startup/shutdown/uninstall）
content/...            # 插件资源（JS 构建产物、图标等），通过 registerChrome 注册
prefs.js               # 可选：默认偏好
locale/...             # 可选：.ftl 本地化文件
```

`manifest.json`（字段已从模板确认）：

```json
{
  "manifest_version": 2,
  "name": "...",
  "version": "...",
  "description": "...",
  "applications": {
    "zotero": {
      "id": "zotero-pdf-auto-crop@example.org",
      "update_url": "",
      "strict_min_version": "7.0",
      "strict_max_version": "8.*"
    }
  },
  "icons": { "48": "content/icons/icon-48.png" }
}
```

`bootstrap.js` 生命周期（模板机制，已确认）：

```js
async function startup({ id, version, resourceURI, rootURI }, reason) {
  var aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "<addonRef>", rootURI + "content/"],
  ]);
  const ctx = { rootURI };
  ctx._globalThis = ctx;
  Services.scriptloader.loadSubScript(`${rootURI}/content/scripts/<addonRef>.js`, ctx);
  await Zotero.<addonInstance>.hooks.onStartup();
}
async function shutdown({...}, reason) { /* reason === APP_SHUTDOWN 时跳过 */ }
```

要点：
- `rootURI` 在开发安装时为 `file:///` 路径，正式安装后为 `jar:file:///...xpi!/`；
- bootstrap 作用域中可直接使用全局 `Zotero`、`Services`、`Components`、`IOUtils` 等
  （Zotero 7 文档与官方 make-it-red 示例确认）；
- 构建产物通过 `loadSubScript` 注入 bootstrap 作用域，模块代码用普通 script 全局模式
  （`var Zotero = ...` 的模拟），需要把入口挂到 `Zotero.<ref>` 上；
- 插件内异步代码应等待 `Zotero.initializationPromise`、`Zotero.unlockPromise`、
  `Zotero.uiReadyPromise`。

### 1.3 本地化

Zotero 7 使用 Fluent（.ftl）。插件可在窗口加载时调用
`win.MozXULElement.insertFTLIfNeeded(rootURI + 'locale/zh-CN.ftl')` 注入自身词条，
菜单/提示即可用 `data-l10n-id` 或 `Zotero.ftl.formatValue` 获取。菜单项 label 也可在
`onShowing` 回调中直接设置（见 §2.1）。

---

## 2. 关键 API 事实（源码引证）

### 2.1 条目右键菜单 —— `Zotero.MenuManager`（不是 `Zotero.Menu`）

`chrome/content/zotero/xpcom/pluginAPI/menuManager.js`（Zotero 7 官方 plugin API）：

```js
Zotero.MenuManager = {
  registerMenu(options) { return this._menuManager.register(options); },
  unregisterMenu(paneID) { return this._menuManager.unregister(paneID); },
};
```

`MenuOptions`：`{ menuID, pluginID, target, menus: MenuData[] }`。
`MenuData`：`{ menuType: "menuitem"|"separator"|"submenu", l10nID?, l10nArgs?, icon?,
onShowing?, onShown?, onHiding?, onHidden?, onCommand?, menus? }`。

- 库条目右键菜单的 target 为 **`"main/library/item"`**（合法 target 列表见源码
  `VALID_TARGETS`，还包括 `main/library/collection`、`reader/menubar/*` 等）。
- 菜单回调签名：`onShowing(event, context)`、`onCommand(event, context)`；
- context 由 ZoteroPane 提供（`buildItemContextMenu`），包含：
  `items`（当前选中的 `Zotero.Item[]`）、`collectionTreeRows`、`tabType`、`tabID`，以及
  动态控制工具：`context.setEnabled(bool)`、`context.setVisible(bool)`、
  `context.setL10nArgs(str)`、`context.setIcon()`、`context.menuElem`。
- 因此 **“只选中单个 PDF 附件才显示菜单，否则 Disabled/隐藏”** 直接在 `onShowing` 中根据
  `context.items` 判断：`items.length === 1 && items[0].isPDFAttachment()`，否则
  `context.setVisible(false)`。
- 分组 target（`main/library/item`）会自动在自定义菜单前加分隔线；菜单项不可在顶层放
  separator。`registerMenu` 返回带插件 ID 前缀的命名 key，卸载用同一 key。
- 菜单更新时机为每次弹窗显示（`notifyType: false`），无需手动刷新。

### 2.2 进度窗口 —— `Zotero.ProgressWindow`（源码确认）

```js
var pw = new Zotero.ProgressWindow({ closeOnClick: true }); // 默认取主窗口
pw.show();
pw.changeHeadline('Analyzing PDF...');
var p = new pw.ItemProgress('file', 'Page 42 / 315');   // 每个进度条一行
p.setProgress(50);                                        // 0-100
p.setText('...');
pw.startCloseTimer(3000);   // 毫秒后自动关闭
pw.close();                 // 立即关闭
```

注意：窗口自身**没有** `addProgressItem`/`setProgress`；`ItemProgress` 从实例创建
（`new pw.ItemProgress(...)`），`setProgress` 在 0/100 时显示完成图标，中间值显示弧形动画。

### 2.3 PDF Reader —— 打开枚举、reload、导航（源码确认）

- 单例：`Zotero.Reader = new Reader()`；已打开的 reader 列表是公开数组
  **`Zotero.Reader._readers`**，每一项（`ReaderTab`/`ReaderWindow`/`ReaderPreview`）
  暴露 **`itemID`** 与 `_isTabClosed`。枚举某附件的 reader：
  `Zotero.Reader._readers.filter(r => r.itemID === itemID && !r._isTabClosed)`。
  另有 `Zotero.Reader.getByTabID(tabID)`。
- **`reader.reload()`**（`xpcom/reader.js:821`）：
  ```js
  async reload() {
    let data = await this._getData();
    this._internalReader.reload(Components.utils.cloneInto(data, this._iframeWindow));
  }
  ```
  reader 内部的 reload（`zotero/reader` 的 `src/common/reader.js`）销毁并重建视图，
  **用内存中的 `viewState`（pageIndex / scale / scrollMode / spreadMode）初始化新视图**
  （`src/pdf/pdf-view.js`：`_viewState = options.viewState || { pageIndex: 0, scale: "page-width", ... }`），
  并恢复滚动位置。结论：**裁剪后调用 `reader.reload()` 即可重读新文件并保留页码与缩放**。
- 打开/导航：`await Zotero.Reader.open(itemID, location)`，`location` 可为
  `{ pageIndex }`（0 基）、`{ annotationID }`、`{ dest }` 等；`reader.navigate(location)` 同。
- 文件来源：Reader 不预读字节，iframe 通过 `zotero://attachment/<lib>/items/<key>/`
  协议由 `ZoteroProtocolHandler.mjs` 按需打开磁盘文件（`item.getFilePathAsync()`），
  **不持有持久文件锁**；pdf.js 打开后在内存持有文档。因此：磁盘上原子替换文件后，
  `reload()` 会读入新版本。Windows 下若要完全避免任何句柄占用，可先 `reload()` 再替换，
  或替换后 reload（见 §7 风险）。

### 2.4 附件 API（源码确认）

- `item.isAttachment()` / `item.isPDFAttachment()`（`isFileAttachment() &&
  attachmentContentType == 'application/pdf'`）/ `isStoredFileAttachment()` /
  `isLinkedFileAttachment()`。
- `item.getFilePath()`（同步，返回绝对路径或 false）/ `item.getFilePathAsync()`（异步，
  校验存在）。
- **实时文件元数据**（每次读取磁盘，不是数据库缓存）：
  - `await item.attachmentModificationTime` → 文件 mtime（ms 时间戳）
  - `await item.attachmentHash` → 文件 MD5（hex）
- `item.saveTx({ skipDateModifiedUpdate: true })` 可避免因保存条目而改 dateModified
  （对 sync 无影响，见 2.5）。

### 2.5 同步机制 —— 文件变化自动检测（源码确认）

`chrome/content/zotero/xpcom/storage/storageLocal.js`：

- 每次文件同步时 `checkForUpdatedFiles(libraryID)` 扫描附件：取磁盘 `IOUtils.stat(path)`
  的 mtime 与数据库 `itemAttachments.storageModTime` 比较（`checkFileModTime`，容忍秒级
  与 1 小时时区差）；mtime 不同再比较磁盘 MD5 与 `storageHash`；都不同则把该附件标记为
  `SYNC_STATE_TO_UPLOAD`，随后 `getFilesToUpload()` 挑出上传。
- 上传时 WebDAV/ZFS 端读取 `await item.attachmentModificationTime` 与
  `await item.attachmentHash`（即实时文件值）。
- `Zotero.Sync.Storage.FileChangeWatcher` 还会在同步开始时对磁盘变化做快照扫描。
- **结论：插件替换附件文件后，下一次 Zotero Sync 会自动发现变化并上传新版本**，用户无需
  任何手动操作；插件也不应直接修改 `itemAttachments` 表。可选地调用公开方法
  `Zotero.Sync.Storage.Local.checkForUpdatedFiles(libraryID, [itemID])` 强制立即标记，
  以及 `Zotero.Notifier.trigger('modify', 'file', [itemID])` 刷新 UI（不影响上传判定）。

### 2.6 PDF 解析/渲染 —— Zotero 不暴露（源码确认）

- `Zotero.PDF` **不存在**于 Zotero 7 客户端源码（已全量 grep 验证）。
- pdf.js 只存在于两个 git 子模块：`zotero/reader`（Reader iframe，
  `resource://zotero/reader/reader.html`）与 `zotero/document-worker`
  （`resource://zotero/document-worker/worker.js`）。
- 唯一相关公共对象是 **`Zotero.PDFWorker`**（`xpcom/pdfWorker/manager.js`），方法全部
  基于 itemID，动作固定：`pdf.writeAnnotations / importAnnotations / deletePages /
  rotatePages / getFulltext / getRecognizerData / renderAnnotations / renderArea /
  hasAnnotations / getStructuredDocumentText`。**没有修改页面盒（MediaBox/CropBox）的动作，
  也不接受任意渲染参数**（`renderArea` 为 reader 内部批注缓存图服务，不适用）。
- **结论**：像素级白边检测所需的“任意页面渲染”，插件必须自带 `pdfjs-dist`（MIT）打包进
  XPI。pdf.js 在 Firefox 特权环境可用（Zotero reader 本身就是例证）；渲染目标使用
  `OffscreenCanvas`（优先）或主窗口隐藏 canvas 兜底，低 DPI（约 100–120 dpi）即可满足
  白边检测精度（见 §6）。

### 2.7 附件文件的读取/写入基础设施

- `IOUtils.read(path)` → `Uint8Array`；`IOUtils.write(path, data)`；
  `IOUtils.stat(path)`；`IOUtils.move / remove / exists`；`PathUtils.join`。
  （Firefox 系统环境全局，bootstrap 作用域可用。）
- `Zotero.File.copyFile(src, dest)` 等传统 API 也可用。

---

## 3. `pdfCropMargins` 算法研究（仅参考，独立实现）

仓库：`abarker/pdfCropMargins`，版本 2.2.1，**GPL-3.0-or-later**（含 LGPL 的 PySimpleGUI
vendor）。**本项目不复制其代码**，仅参考算法思想；本插件采用 MIT 许可，无兼容性问题。

### 3.1 内容包围盒（Bounding Box）

- **一律基于渲染图像**：PyMuPDF 模式也走 displaylist 渲染（identity matrix，即 1px/pt），
  外部渲染器为 pdftoppm / Ghostscript；**不做** `get_text('dict')`/`get_drawings()`/
  `get_image_bbox()` 之类的元素提取（作者注释明确表示仅渲染路径适用于扫描件）。
- 图像分析：灰度化 → 阈值（默认 191，即约 75%；`--threshold` 可调，负值反转用于深色背景）
  → 二值化 → `PIL.getbbox()`。可选 `--numBlurs`/`--numSmooths` 做平滑。
- **没有**连通域/噪点消除：鲁棒性完全依赖阈值 + 每边 order statistic。
- 空白页：`getbbox()` 为 None 时按页面中心一个退化框处理。
- 像素→PDF 单位按“页面盒宽度/图像宽度”换算；y 轴翻转（图像 top-left → PDF bottom-left）。

### 3.2 统一裁剪（uniform crop）

- 每页先算四边“可裁剪量” delta = |full_box_edge − bbox_edge|（默认保留 margin 的 10%，
  `--percentRetain 10`）。
- 每边独立排序后取第 n 个值（`--uniformOrderStat`，默认 n=0 即每边最小值；
  `--uniformOrderPercent` 可给百分比；`-m 1` 对 arXiv 首页日期注记很有效）。
- 所有页共享同一个四元组 delta → `crop = [left+dl, bottom+db, right−dr, top−dt]`。
- `--cropSafe`：把裁剪钳制回“不越过任何一页的 tight bbox”；`--cropSafeMin4` 允许
  越过 bbox 的最小量（可为负）。

### 3.3 奇偶页（--evenodd）

- 递归把页面按 `p % 2` 分成两组，各自独立做 uniform 裁剪，再合并；若同时 `--uniform`，
  则仅垂直方向两组统一。

### 3.4 旋转页

- 读取 `/Rotate`（0/90/180/270）后先 `set_rotation(0)` 统一到未旋转坐标计算；用户的
  四边参数（left/bottom/right/top）按顺时针旋转做置换（`mod_box_for_rotation`，
  90° 时 left↔top 等），最后写盒前恢复 rotation。**CropBox/MediaBox 始终以未旋转
  PDF 坐标书写**（这是 PDF 规范要求，观看器负责按 /Rotate 显示）。

### 3.5 恢复（restore）

- 恢复数据保存在 **PDF 的 Info 字典**（trailer `/Info`）自定义键
  `pdfCropMarginsRestoreData`：值是“每页原始 MediaBox∩CropBox”的序列化列表字符串；
  首次裁剪还会给 Producer 追加标记。恢复时按页写回 MediaBox（先）与 CropBox，并删除键。
- 恢复数据按页数与文档页数核对，不一致则忽略并警告。
- 也支持“原始盒已保存过则再次裁剪不覆盖”的语义（检测到已有 restore 数据即视为已裁剪）。

### 3.6 写入方式与页面盒

- 默认 `--boxesToSet m`：只写 MediaBox（PyMuPDF 的 set_mediabox 会重置其余盒为包含关系，
  实际效果 CropBox 也等于新尺寸）；`-b c/t/a/b` 可显式写 CropBox/TrimBox/ArtBox/BleedBox。
- “完整页尺寸”参考默认为 **MediaBox∩CropBox**（`--fullPageBox m c`）。
- 输出为 PyMuPDF 全量保存（非增量）；内容流从不被触碰。

### 3.7 对我们的启示（差异点与取舍）

| 维度 | pdfCropMargins | 本插件设计 |
|---|---|---|
| 检测 | 渲染→阈值 191→getbbox（无降噪） | 渲染→背景估计→自适应阈值→行扫描降噪（扫描件更稳） |
| 统一裁剪 | 每边 order stat n=0（min） | 组内 min/max + 异常页过滤 + 安全钳制（更保守，绝不切内容） |
| 奇偶 | 手动开关 | 自动识别镜像页边距（V1 规则 + 可配置） |
| 恢复 | Info 字典自定义键 | Info 字典自定义键 + XMP 命名空间（双保险，跨工具可读） |
| 页面盒 | 默认 MediaBox（PyMuPDF 联动） | 写 CropBox，若存在 Trim/Bleed/Art 同步写；MediaBox 保持（仅裁剪显示区域，更保守） |
| 安全边距 | percentRetain 10% 保留 | **固定 2 mm 四边 padding**（任务规格要求） |

---

## 4. PDF 写入引擎选型：pdf-lib（已验证）

### 4.1 为什么需要

Zotero 无任何可修改页面盒的内置能力（§2.6）；必须打包一个纯 JS PDF 写入库。
候选对比：

| 方案 | 结论 |
|---|---|
| 自写 PDF 修改器（解析 xref/对象流/重写） | 高风险：对象流、增量更新、交叉引用错误会损坏文件，违背“原文件必须安全” |
| Ghostscript/Poppler/qpdf 打包 | 体积大、跨平台分发复杂，违背“零外部依赖” |
| **pdf-lib（MIT，纯 JS）** | **采用**：加载→改盒→保存全量重写，流字节原样保留，1.2 MB 可打包 |

### 4.2 已验证的能力（pdf-lib 1.17.1 源码）

- **页面盒 API**（`src/api/PDFPage.ts`）：
  `setMediaBox(x, y, width, height)` / `setCropBox(...)` / `setTrimBox` / `setBleedBox` /
  `setArtBox`（左下原点，存 `[x, y, x+w, y+h]`）；`getMediaBox()` 返回
  `{x, y, width, height}`；`getRotation()`/`setRotation()`（仅 90 的倍数）。
- **加载**：`PDFDocument.load(bytes, { updateMetadata: false })`；
  `ignoreEncryption`、`throwOnInvalidObject`、`parseSpeed`、`capNumbers` 为全部选项
  （无密码解析——**任何含 `/Encrypt` 的 PDF 都会抛 `EncryptedPDFError`**，正好用于
  “拒绝加密 PDF”）。
- **保存**：`save()` 全量重写（无增量保存）；`SaveOptions` 含
  `useObjectStreams`（默认 true）、`addDefaultPage`（仅 0 页文档加页，无影响）、
  `updateFieldAppearances`（仅当调用过 `getForm()` 才有效）。
- **保真度**：
  - 内容流、XMP 流、嵌入文件、图像 XObject：**字节原样保留**（`PDFRawStream`，不重压缩）；
  - `/Annots`、`/Outlines`、`/AcroForm`、链接：作为对象图整体重序列化，**不丢失**；
  - 未知/损坏对象：`PDFInvalidObject` 原字节透传；
  - 头一律重写为 `%PDF-1.7`；`updateMetadata: false` 时 Info 字典**不动**。
- **元数据**：
  - Info 字典：`pdfDoc.context.lookup(pdfDoc.context.trailerInfo.Info, PDFDict)` 后
    `info.set(PDFName.of('Key'), PDFString.of('...'))`，任意自定义键可读写；
  - XMP：`const s = pdfDoc.context.stream(xmpBytes, { Type: 'Metadata', Subtype: 'XML' })`
    + `pdfDoc.catalog.set(PDFName.of('Metadata'), pdfDoc.context.register(s))`；
    读取：`catalog.lookup(PDFName.of('Metadata'), PDFStream)` + `decodePDFRawStream`。
- **依赖**：`@pdf-lib/standard-fonts`、`@pdf-lib/upng`、`pako`、`tslib`；esbuild 可干净
  打包（也可直接打 `dist/pdf-lib.esm.js` 单文件）。
- **边界**：仅改盒不触发内容流 `normalize()`（绘图类操作才会）；`getForm()` 会警告并移除
  XFA（我们不调用即可）。

### 4.3 结论

pdf-lib 满足全部需求：改 MediaBox/CropBox、保留内容流与 annotation/outline、读写自定义
元数据、加密检测。输出文件为全量重写（内容流字节不变），配合“临时文件 + 校验 + 原子替换”
流程（§7）保证原文件安全。

---

## 5. 关键问题回答（任务 §50 Phase 1 的 8 问）

1. **Zotero 插件能否直接获得 PDF 页面渲染结果？**
   不能直接：`Zotero.PDF` 不存在，pdf.js 内嵌于 Reader/worker。插件须自带 pdfjs-dist
   并自行渲染（低 DPI、`OffscreenCanvas`）。这是唯一的“插件内渲染”可靠途径。
2. **是否能安全修改 PDF MediaBox/CropBox？**
   能，但 Zotero 不提供该能力，须用打包的 pdf-lib 修改。修改只改页面盒，不动内容流，
   对显示效果（pdf.js/Zotero Reader 均按 CropBox 渲染）与打印（TrimBox 同步设置）都正确。
3. **是否存在 Zotero 内置可复用 PDF writer？**
   不存在。`Zotero.PDFWorker` 仅支持固定动作（旋转/删页/批注/全文），无页面盒写入。
4. **是否必须引入第三方 PDF 库？**
   是，必须：pdfjs-dist（渲染分析）+ pdf-lib（写入）。两者均为 MIT、纯 JS、无原生依赖、
   可打包进 XPI，用户无需安装任何东西（符合“安装 XPI 直接使用”）。
5. **修改 CropBox/MediaBox 是否影响 Zotero annotation？**
   不影响。Zotero 批注存储在本地数据库（`itemAnnotations`，坐标 `{pageIndex, rects}`，
   为 PDF 页面未旋转坐标系），与页面盒无关；PDF 内嵌批注对象由 pdf-lib 原样保留。
   只需在裁剪/恢复后 `Zotero.Notifier.trigger('modify', 'item', [annotationIDs])`（或
   触发 `'modify','item'` 通知）刷新 UI。恢复原始盒后坐标同样不变。
6. **如何安全刷新 Reader？**
   枚举 `Zotero.Reader._readers.filter(r => r.itemID === itemID && !r._isTabClosed)`，
   对每个 `await reader.reload()`。reload 重读磁盘文件并用内存 viewState 恢复页码/滚动/
   缩放（源码确认）。若 reload 抛错（文件被锁等），则退化为关闭标签页后
   `Zotero.Reader.open(itemID, { pageIndex })` 重开。
7. **如何通知 Zotero Sync 附件已变化？**
   无需手动通知：sync 的 `checkForUpdatedFiles` 自动比对磁盘 mtime/MD5 与数据库
   `storageModTime`/`storageHash`，文件变了自动上传。可选增强：
   `await Zotero.Sync.Storage.Local.checkForUpdatedFiles(libraryID, [itemID])`
   立即标记 + `Zotero.Notifier.trigger('modify', 'file', [itemID])` 刷新 UI。
8. **如何做到 Windows/macOS/Linux 零外部依赖？**
   纯 JS（pdfjs-dist + pdf-lib）+ Firefox 内置 API（IOUtils 原子操作）+ 平台无关的
   “临时文件 + fsync + 替换”流程。Windows 下用 `IOUtils.move`（rename）覆盖，
   失败时重试并在 README 记录已知限制（文件被其他程序独占时提示用户关闭）。

---

## 6. 算法设计（V1）

### 6.1 像素分析（page-analyzer）

- 用 pdfjs-dist 渲染每页到画布：分辨率取 **约 100–120 DPI**（`scale = dpi/72`；
  单边像素上限约 2000，避免超大页爆内存），`OffscreenCanvas` 优先、隐藏 canvas 兜底；
- 提取 `ImageData`；**背景估计**：取页面四周边缘带（如各边 3% 宽）像素的中位数灰度作为
  该页背景色（兼容纸黄/浅灰扫描件）；内容像素判定：
  `|gray(p) − bg| > threshold（默认约 12–16）` 且颜色距离足够（抗 JPEG 噪声）；
- 行扫描降噪：每行内连续内容像素段长度 ≥ 2（100 DPI 下约 0.5 mm）才计入；再对列做同样
  过滤；噪点密集但面积占比 < 0.02% 的孤立像素块不计入（简化实现，不做完整连通域）；
- 输出该页未旋转坐标系 content bbox（渲染视口用旋转后尺寸，bbox 通过旋转映射回
  未旋转坐标，见 6.4）。
- 空白页（内容像素占比 < 0.05%）标记 special，不参与组统计。

### 6.2 页面分组（document-layout）

- 分组键：(a) 未旋转 MediaBox 尺寸聚类（容差 1 pt），(b) 旋转角 0/90/180/270；
- **奇偶自动识别**：组内页数 ≥ 8 且奇数页与偶数页的左侧内容边中位数差 > 1.5% 页宽时，
  拆分为 odd/even 两组（书籍镜像页边距），否则单组；
- 组内异常页（outlier）：内容盒任一边偏离组中位数 > max(12% 页宽/高, 8 pt)，或内容面积
  比 < 中位数的 25%（整页图/封面/空白）→ 标 special。

### 6.3 稳定裁剪框（stabilization）

- 对每个“正常组”，四边取组内所有 content bbox 的**并集（min left / min bottom /
  max right / max top）**，再外扩 2 mm 安全边距（`DEFAULT_SAFE_MARGIN_MM = 2`），
  并钳制在 MediaBox 内、且每边裁剪量不超过页尺寸 35%（防误检）：
  - 组内所有页共用同一个 CropBox（避免翻页跳动）；
  - 单页特例：内容盒离组并集偏差大（已在分组时标 special）的页面，使用**该页自己的
    content bbox + 2 mm** 作为裁剪框（通常等于不裁剪或轻微裁剪，保证安全）。
- 比 pdfCropMargins 更保守：组裁剪永不进入任何正常页的 content bbox（“宁可多留白边”）。

### 6.4 旋转处理（rotation）

- 渲染视口按“旋转后”尺寸；content bbox 在显示坐标系得到；
- 2 mm padding 按显示坐标（用户看到的上/下/左/右）施加；
- 显示坐标系 bbox → 未旋转 PDF 坐标：按 /Rotate 的 90° 置换映射
  （参考 pdfCropMargins `mod_box_for_rotation` 思想，独立实现并单测覆盖 0/90/180/270）；
- 写盘时只写未旋转坐标的 CropBox，不动 /Rotate。

### 6.5 恢复元数据（crop-metadata）

- 首次裁剪前读取每页 MediaBox/CropBox（含 TrimBox/BleedBox/ArtBox 若存在）保存为
  “原始盒”JSON（版本字段 + 页面数 + 每页 4 盒）；
- 存储位置（双写）：
  1. Info 字典自定义键 `ZoteroPdfAutoCropRestore`（仿 pdfCropMargins 思路，简单可靠）；
  2. XMP 自定义命名空间 `https://github.com/.../zotero-pdf-auto-crop#`（跨工具可读）。
- 再次裁剪：检测到已有原始盒元数据则复用，**绝不覆盖**（多次裁剪始终基于最初的原始盒）；
- 恢复：读元数据 → 写回各页 MediaBox/CropBox（保留元数据以便重新裁剪）。

### 6.6 写盘与安全替换（temp-file + atomic replace）

1. `IOUtils.read(原文件)` → 全内存处理（pdf-lib 全量重写；500 页书籍几十 MB 可接受；
   超过 256 MB 或解析失败 → 拒绝并提示）；
2. 写入**同目录**临时文件 `.<name>.zpac.tmp.pdf`（同目录保证 rename 原子性跨文件系统）；
3. 校验输出：pdfjs-dist 重新解析临时文件（页数一致、页对象可读、元数据可读），
   pdf-lib 重新加载并抽查页面盒值；
4. 处理打开的 Reader（见 2.3/§5-Q6）；
5. `IOUtils.move(tmp, orig, { noOverwrite: false })`（Windows 若失败则提示用户关闭占用）；
6. 触发 `Zotero.Notifier.trigger('modify', 'file', [itemID])`；
7. 任何一步失败：删除临时文件，原文件保持不动，向用户明确提示“PDF 未被修改”。

### 6.7 加密 / 签名 / 损坏检测

- 加密：pdf-lib 加载抛 `EncryptedPDFError` → 拒绝 + 明确提示；
- 数字签名：原始字节扫描 `/ByteRange`（签名必需）或 catalog AcroForm 存在 /Sig 字段 →
  拒绝 + 提示“此 PDF 包含数字签名，修改会使签名失效”；
- 损坏：pdf-lib 加载异常 / `throwOnInvalidObject` 校验 / 页树解析失败 → 停止，原文件不动。

---

## 7. 风险与替代方案

| 风险 | 影响 | 缓解 / 替代 |
|---|---|---|
| pdfjs-dist 在插件特权环境渲染受限 | 分析不可用 | 主窗口隐藏 canvas 兜底；若仍不可行，退化为“文本/矢量对象 bbox”检测（方案 B），并在文档中记录 |
| pdf-lib 全量重写导致文件变大/结构变化 | 大文件慢 | 只允许 ≤ 256 MB；写入临时文件 + 校验后才替换；必要时提示用户 |
| Windows 文件占用导致替换失败 | 替换失败 | 先 reload reader；`IOUtils.move` 失败时给出明确错误（原文件安全）；README 记录 |
| 扫描件边缘阴影/倾斜 | 检测偏保守 | 背景估计 + 阈值 + 行扫描降噪；仍偏保守（安全方向）；V2 可加 deskew/阴影去除 |
| 整页图/封面页干扰 | 组裁剪失效 | 异常页过滤（§6.2）+ 单页安全框 |
| Zotero 未来 API 变动 | 插件失效 | 使用公开 API（MenuManager/Reader/ProgressWindow/Item）；bootstrap 机制为官方推荐 |
| GPL 传染质疑 | 许可风险 | 独立实现，未复制 pdfCropMargins 代码（仅参考算法思想与选项语义）；MIT 发布 |

---

## 8. 测试策略（对应任务 §44–§48）

- **fixtures**：用 pdf-lib 脚本生成合成 PDF（无版权问题）：普通论文、双栏、大边距、
  扫描件（嵌入合成的灰度 PNG，含噪声/阴影）、书籍奇偶、横向页、混合尺寸、整页图、
  小边距、内嵌批注/书签/链接；
- **单元测试**（vitest，纯函数）：mm→pt、PageBox 运算、旋转映射、分组、异常检测、
  稳定化、元数据编码/解码、恢复；
- **集成测试**（vitest + pdfjs-dist + @napi-rs/canvas）：裁剪→重新打开验证页数/文本/
  图片/outline/批注；裁剪→恢复→页面盒等于原始；扫描件裁剪不切内容；
- **安全测试**：注入写临时文件失败/权限错误/写入器抛异常/替换失败，验证原文件字节不变；
- **Zotero 实机测试**（人工清单，本环境无法执行）：右键菜单、Reader reload 保留页码、
  Sync 上传、平板端显示、Windows/macOS/Linux 交叉验证。

---

## 9. 参考来源

- Zotero 源码（master）：`chrome/content/zotero/xpcom/pluginAPI/menuManager.js`、
  `xpcom/progressWindow.js`、`xpcom/reader.js`、`xpcom/data/item.js`、
  `xpcom/pdfWorker/manager.js`、`xpcom/storage/storageLocal.js`、`xpcom/storage/storageEngine.js`、
  `chrome/content/zotero/zoteroPane.js`、`ZoteroProtocolHandler.mjs`
- `zotero/reader`（fork）：`src/common/reader.js`、`src/pdf/pdf-view.js`
- `zotero/document-worker`：`src/index.js`、`src/pdf/pdfassembler.js`
- `abarker/pdfCropMargins`（GPL-3.0-or-later）：README、`main_pdfCropMargins.py`、
  `calculate_bounding_boxes.py`、`pymupdf_routines.py`
- `Hopding/pdf-lib`（MIT）：`src/api/PDFPage.ts`、`src/api/PDFDocument.ts`、
  `src/core/PDFContext.ts`、`src/core/writers/PDFWriter.ts`、`src/core/parser/PDFParser.ts`
- 社区模板 `windingwind/zotero-plugin-template`（bootstrap.js / manifest.json 结构）
