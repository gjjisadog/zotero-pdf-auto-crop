/**
 * 裁剪相关核心数据结构（任务 §34）。
 */
import type { PageBox } from './bounding-box';

/** 单页分析结果（未旋转 PDF 坐标） */
export interface PageAnalysis {
  pageIndex: number;
  /** 页面 MediaBox（未旋转坐标） */
  mediaBox: PageBox;
  /** 页面当前 CropBox（未旋转坐标；缺省时等于 MediaBox） */
  cropBox: PageBox;
  /** 检测到的内容包围盒（未旋转坐标；空白页为 null） */
  contentBox: PageBox | null;
  /** 页面旋转（0/90/180/270，顺时针） */
  rotation: number;
  /** 内容占比过低（空白页） */
  isBlank: boolean;
  /** 深色背景页（整页图/深色封面）：渲染分析不可靠，不裁剪 */
  darkBackground: boolean;
  /** 与组内主体页偏差过大（封面/整页图/横向表等） */
  isOutlier: boolean;
  /** 渲染/分析失败（按安全方式处理：不裁剪） */
  analysisFailed: boolean;
}

export type PageGroupKind = 'normal' | 'odd' | 'even' | 'blank' | 'outlier' | 'failed' | 'dark';

export interface PageGroup {
  id: string;
  kind: PageGroupKind;
  pageIndexes: number[];
  /** 组内页面共享的未旋转 MediaBox 尺寸 */
  width: number;
  height: number;
  rotation: number;
}

export interface DocumentLayout {
  groups: PageGroup[];
  /** pageIndex -> groupId */
  groupOf: Map<number, string>;
}

/** 每页最终裁剪框 */
export interface PageCrop {
  pageIndex: number;
  /** 未旋转 PDF 坐标 */
  cropBox: PageBox;
  groupId: string;
  kind: PageGroupKind;
  /** 该页是否被实际修改（与当前 CropBox 不同） */
  changed: boolean;
}

export interface CropConfig {
  /** 安全边距（pt），默认 2 mm */
  safeMarginPt: number;
  /** 单边最大裁剪比例（相对页面尺寸），防止误检导致过度裁剪 */
  maxCropFraction: number;
  /** 异常页判定：内容盒任一边偏离组中位数超过 max(该比例×页面尺寸, minEdgeDeviationPt) */
  outlierEdgeDeviationFraction: number;
  outlierMinEdgeDeviationPt: number;
  /** 空白页判定：内容面积占比低于该值 */
  blankAreaFraction: number;
  /** 奇偶分组：组内页数达到该值才启用 */
  oddEvenMinPages: number;
  /** 奇偶分组：奇数页与偶数页左侧内容边中位数差异（相对页宽）超过该值才拆分 */
  oddEvenMarginDiffFraction: number;
  /**
   * 强制保护：要求页面字体全部嵌入（非嵌入字体页不裁剪）。
   * 默认关闭——Zotero 中 standard fonts（chrome://）可用时渲染可靠；
   * 真实缺字场景由渲染期的字体加载检测（fontDataMissing）兜底。
   */
  requireEmbeddedFonts: boolean;
  /** 深色背景判定：背景灰度低于该值视为深色页（整页图等），不裁剪 */
  darkBackgroundGray: number;
}

export const DEFAULT_CROP_CONFIG: CropConfig = {
  safeMarginPt: 2 * (72 / 25.4),
  maxCropFraction: 0.35,
  outlierEdgeDeviationFraction: 0.12,
  outlierMinEdgeDeviationPt: 8,
  blankAreaFraction: 0.0005,
  oddEvenMinPages: 8,
  oddEvenMarginDiffFraction: 0.015,
  requireEmbeddedFonts: false,
  darkBackgroundGray: 200,
};
