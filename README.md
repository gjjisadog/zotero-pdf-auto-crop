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

## 支持版本

- Zotero **7 / 8 / 9**（当前稳定版 Zotero 9.0.6 上开发验证）
- Windows / macOS / Linux
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
- **布局分析**：按（页面尺寸 × 旋转角）分组；书籍镜像页边距自动拆分为奇偶两组；
  封面、整页图、空白页、特殊尺寸页自动识别为异常页，**单独安全处理，不破坏整体裁剪**。
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
- 加密 PDF、含数字签名的 PDF、损坏/无法解析的 PDF：**直接拒绝修改**并明确提示；
- 大文件上限 256 MB（超出提示，不处理）。

## Annotation 兼容说明

- Zotero 批注（高亮/下划线/笔记/区域/墨迹）存储在 Zotero 数据库中，坐标基于 PDF
  页面内容坐标系——修改页面边界**不改变任何内容坐标**，批注位置不受影响；
- PDF 文件内嵌的批注、链接、书签、表单等对象由写入引擎原样保留（已测试验证）；
- 裁剪与恢复后批注均保持正确位置。

## Sync 说明

- 裁剪/恢复后，Zotero 会**自动检测到附件文件变化**并在下次同步时上传新版本
  （比较文件修改时间与 MD5）；用户无需删除附件、重新导入或手动强制同步；
- iPad / Android / 墨水屏等**移动端无需安装本插件**——同步下载后直接按裁剪后的
  CropBox 显示，正文更大。

## 已知限制

- 深色背景页（整页图/深色封面）不裁剪（保守处理）；
- 扫描件的边缘阴影/黑边会被自动忽略；明显的**倾斜**扫描件不矫正（V1 不做 deskew）；
- 页面边缘的**大面积深色图块**（如照片占满边距）可能被当作扫描阴影忽略；
- 正在被其他程序独占的 PDF（Windows）替换失败时会明确提示，原文件不受影响；
- 裁剪后「适应页面宽度」显示会立即生效；已打开的 Reader 自动刷新并保留页码。

## 许可证

MIT License（详见 [LICENSE](LICENSE)）。

算法设计参考了 [abarker/pdfCropMargins](https://github.com/abarker/pdfCropMargins)
（GPL-3.0-or-later）的思想，但本插件为其**独立实现**，未复制其源码，不受 GPL 传染；
运行时依赖为 MIT 许可的纯 JavaScript 库（pdf-lib、pdf.js）。

## 开发

```bash
npm install
npm run gen-fixtures   # 生成合成测试 PDF（无版权）
npm test               # 单元 + 集成 + 安全测试（73 项）
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
