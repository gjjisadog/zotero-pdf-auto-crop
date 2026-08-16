# Zotero PDF Auto Crop

> 对 Zotero 中已导入的 PDF 附件进行**自动白边检测**，并通过修改 PDF 页面边界
> （CropBox）实现**非栅格化、可恢复**的智能裁剪，使裁剪后的 PDF 在 iPad、
> Android 平板、墨水屏等设备中获得更大的正文显示比例。

![License](https://img.shields.io/badge/license-MIT-blue)

---

## 插件用途

论文、电子书 PDF 常带有大面积的顶部/底部/左右白边，平板上阅读时正文显示很小。
本插件在 **Zotero 条目右键菜单**中对选中的 PDF 附件执行：

```
自动检测每页正文区域（Content Bounding Box）
        ↓
文档级布局分析（页面尺寸/旋转分组 + 书籍奇偶页自动识别 + 异常页过滤）
        ↓
计算稳定、统一的裁剪框（组内所有页共用，避免翻页跳动）
        ↓
四边外扩 2 mm 安全边距
        ↓
写入 CropBox（并同步 TrimBox/BleedBox/ArtBox），原子替换原附件
```

**不重新排版、不栅格化、不触碰任何内容流**——文本、字体、矢量图、图片、超链接、
目录、书签、元数据与批注全部原样保留。

**只修改 CropBox**（阅读器显示区域）；MediaBox / TrimBox / BleedBox / ArtBox
等印刷语义页面盒一律不动。

## 支持版本

- Zotero **9.x**（当前稳定版 9.0.6 上实机验证；7/8 未实测，暂不声明兼容）
- Windows / macOS / Linux（Windows 路径处理已按跨平台实现，待实机验证）
- 无需安装 Python、Ghostscript、Poppler 或任何外部程序；插件自带全部依赖

## 安装方法

1. 从 Releases 下载 `zotero-pdf-auto-crop-<version>.xpi`；
2. Zotero → 工具 → 插件 → 右上角齿轮 → **Install Plugin From File…**；
3. 选择 XPI 并重启 Zotero（如提示）。

开发构建：`npm install && npm run build`，产物在 `dist/`。

## 使用方法

1. 在 Zotero 条目列表中**选中一个 PDF 附件**（`application/pdf`，含链接文件与存储文件）；
2. 右键 → **自动裁剪 PDF 白边**；
3. 完成后原附件即为裁剪版本；正在阅读该 PDF 的 Reader 会**自动刷新并保留当前页码**；
4. 如需还原：右键 → **恢复原始页面**。

> 只对「单个 PDF 附件」显示菜单；选中父文献条目、文件夹、Collection、网页附件、
> EPUB、图片等其他对象时菜单自动隐藏。

## 自动裁剪原理

- **内容检测**：以约 100 DPI 逐页渲染（pdf.js），估计页面背景色（兼容纸黄/浅灰扫描件），
  按灰度阈值判定内容像素，行/列 run 过滤消除扫描噪点，并自动排除扫描阴影/黑边
  （边缘暗带检测）。**不依赖文本层**，扫描 PDF 同样适用。
- **扫描黑边仅高置信度排除**：边缘暗带必须同时满足「整列/整行占比高 + 带宽窄 +
  带内灰度均匀 + 明显暗于页面背景」才会被当作扫描伪影排除；贴边照片条、出版社色条、
  侧栏等真实内容（纹理复杂或颜色多变）**绝不会被误裁**。
- **布局分析**：按（页面尺寸 × 旋转角）分组；书籍镜像页边距自动拆分为奇偶两组；
  封面、整页图、空白页、特殊尺寸页自动识别为异常页，**单独安全处理，不破坏整体裁剪**。
  奇偶/异常统计全部使用「显示局部坐标」（减去各页 MediaBox 原点），
  同尺寸不同原点的页面不会被误判。
- **稳定化**：正常组内所有页共用「内容并集 + 2 mm」的裁剪框，翻页时正文不跳动；
  每边裁剪量不超过页面尺寸的 35%（防误检过度裁剪）。
- **旋转页面**（0°/90°/180°/270°）正确处理：2 mm 边距按**用户看到的**左/右/上/下施加。

### 2 mm 安全边距

裁剪框四边固定外扩 **2 mm**（≈ 5.67 pt，1 mm ≈ 2.83465 pt），保证正文与页面边缘之间
始终留有呼吸空间；**自动裁剪宁可多留白边，绝不允许切掉正文**——裁剪区域永远不会进入
检测到的内容包围盒。

## 恢复原始页面

- 首次裁剪时，每页的原始 MediaBox / CropBox（含 TrimBox/BleedBox/ArtBox）会保存到
  **PDF 内部**（Info 字典 `ZoteroPdfAutoCropRestore` 键 + XMP 命名空间
  `https://github.com/zotero-pdf-auto-crop#`），**不会生成任何备份附件文件**；
- 右键 **恢复原始页面** 即按保存的数据还原页面边界；
- **多次重新裁剪始终基于最初的原始盒**（恢复信息只写一次，绝不覆盖）；
- 若 PDF 从未被本插件裁剪，恢复菜单会置灰/提示「没有可恢复的原始页面信息」。

## 数据安全说明

> **插件会修改 Zotero 管理的 PDF 文件本身**（覆盖原附件，不生成第二个 PDF）。

为保护您的文件，插件严格遵循：

```
读取原 PDF → 生成同目录临时文件 → 重新解析校验（页数/裁剪框）→ 原子替换原文件
```

- 写入、校验或替换**任何一步失败，原 PDF 保持完全不变**（临时文件被清理）；
- **源文件一致性保护**（裁剪与恢复同等）：操作前执行 `stat → read → stat` 稳定快照，
  替换前再校验一次文件指纹（大小 + 修改时间）——处理期间被 Zotero Sync / Dropbox /
  外部编辑器改写的版本**绝不会被旧结果覆盖**；
- 加密 PDF、含数字签名的 PDF（裁剪**和**恢复都会拒绝）、损坏/无法解析的 PDF：
  **直接拒绝修改**并明确提示；
- 大文件上限 256 MB（超出提示，不处理）；
- 页面盒的间接引用（`/CropBox 12 0 R`）正确解析；恢复时同时还原「可见区域」与
  「直接声明/继承」结构状态，绝不留下多余的直接 CropBox。

## Annotation 兼容说明

- PDF 文件内嵌的批注、链接、书签等对象在裁剪/恢复后**数量与坐标（Rect）均保持不变**
  （自动化测试逐项比较验证）；
- Zotero 自身创建的批注（高亮/笔记/区域等）存储在 Zotero 数据库中，坐标为 PDF
  页面内容坐标系；修改页面边界不改变任何内容坐标，理论上不受影响——**该结论基于
  架构分析，实机闭环（在 Reader 中逐项检查）待确认**。

## Sync 说明

- 裁剪/恢复后，**Sync 完全由 Zotero 处理**：Zotero 每次同步自动比较磁盘文件
  修改时间与 MD5，检测到变化即上传新版本；用户无需删除附件、重新导入或手动
  强制同步；
- iPad / Android / 墨水屏等**移动端无需安装本插件**——同步下载后直接按裁剪后的
  CropBox 显示，正文更大。

## 已知限制

- 深色背景页（整页图/深色封面）不裁剪（保守处理）；
- 扫描件的边缘阴影/黑边会按「高置信度伪影」规则自动忽略；明显的**倾斜**扫描件
  不矫正（V1 不做 deskew）；
- 贴边且**均匀、深色**的窄条（如纯色深色装饰条）在灰度上与扫描黑边不可区分，
  按保守策略处理（置信度不足时不排除，宁可少裁）；
- 正在被其他程序独占的 PDF（Windows）替换失败时会明确提示，原文件不受影响；
- 裁剪后「适应页面宽度」显示会立即生效；已打开的 Reader 自动刷新并保留页码。

## 许可证

MIT License（详见 [LICENSE](LICENSE)）。

算法设计参考了 [abarker/pdfCropMargins](https://github.com/abarker/pdfCropMargins)
（GPL-3.0-or-later）的思想，但本插件为其**独立实现**，未复制其源码，不受 GPL 传染；
运行时依赖：**pdf-lib（MIT）**、**PDF.js（Apache-2.0）**、标准字体数据；
第三方许可证详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，
XPI 发行包内包含对应许可证文本（`licenses/`）。

## 实机验证（Zotero 9.0.6，macOS）

已在 Zotero 9.0.6（macOS）上完成实机验证：

- **安装**：XPI 经 AddonManager 注册成功，bootstrap startup 正常执行；
- **菜单**：条目右键菜单注册成功（`Zotero.MenuManager`）；
- **端到端裁剪**：真实进程内完成 渲染（主窗口 canvas + 自带 pdf.js）→
  像素分析（扫描阴影自动排除）→ 布局/稳定化 → 写 CropBox → 临时文件 +
  校验 + 原子替换 → 恢复元数据写入（Info 字典），裁剪框与单元测试结果一致；
- **恢复**：按元数据还原原始可见区域（CropBox，原本无 CropBox 时删除），与原始完全一致；
- 右键菜单的显示逻辑（仅单个 PDF 附件可见）与 Reader 自动刷新、Sync 上传
  属于 GUI 交互路径，请在真实使用中确认。

> 实机调试中发现并修复的 Zotero 9 环境问题（均已在代码中解决）：
> bootstrap 全局缺少 `DOMException`/`console`/`ReadableStream` 等 DOM 构造器
> （启动时从主窗口补齐）、`IOUtils.read` 返回跨 realm 数组（复制到当前
> realm）、pdf.js 渲染需要 `ownerDocument`（传入主窗口 document）；
> manifest 的 `applications.zotero` 必须包含**非空 `update_url`**（缺失时
> AddonManager 在启动时静默移除插件并删除 XPI）；
> DOM 全局补丁只对 realm 敏感构造器（`Path2D`/`DOMMatrix`/`ImageData`）做
> 主窗口变化时的无条件刷新，`atob`/`TextEncoder` 等基础全局只能缺失补齐
> （无条件覆盖会破坏 pdf.js 的字符串解码）。

## 开发

```bash
npm install
npm run gen-fixtures   # 生成合成测试 PDF（无版权）
npm test               # 单元 + 集成 + 安全测试（108 项）
npm run build          # 构建 dist/*.xpi
```

代码结构：

```
src/
├─ index.ts            # 插件入口（Zotero.<addonInstance>）
├─ addon.ts            # 生命周期 hooks
├─ ui/context-menu.ts  # 条目右键菜单（V1 唯一入口）
├─ crop/               # 核心引擎（不依赖 Zotero UI）
│  ├─ crop-service.ts  # 编排：分析→布局→稳定化→写入→校验→原子替换
│  ├─ page-analyzer.ts # 像素级内容包围盒检测
│  ├─ document-layout.ts / stabilization.ts / rotation.ts
├─ pdf/                # pdfjs 渲染抽象 + pdf-lib 写入 + 恢复元数据
├─ zotero/             # 附件 / Reader / Sync / 进度集成
└─ utils/              # 单位换算、临时文件原子替换、日志
```
