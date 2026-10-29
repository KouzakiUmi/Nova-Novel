/**
 * Nova Novel 图标几何数据（唯一来源）。
 *
 * 设计语言「N² · 新星」：
 * - 取自 Pi 标志的做法：整枚标记由同尺寸方格拼成，只有直角和实心色块，
 *   再按功能切成几块上色，不使用渐变与装饰。
 * - 品牌记号是一枚 5×5 方格拼成的 N（N 占一个正方形，即 N 的平方），
 *   在右上角“指数”位置放一颗新星，合起来读作 N²。
 * - 功能图标沿用同一条规则：主体落在左下方的方格区，
 *   新星固定在右上角指数位，主体里用一块实心“方砖”呼应方格。
 *
 * React 组件（icons.tsx）与独立 SVG 生成脚本（scripts/build-icons.mjs）
 * 都读取本文件，避免两处各画一份。本文件只含纯数据和路径函数，不依赖 React。
 */

export type IconPart =
  /** 描边路径，使用 currentColor。 */
  | { kind: "stroke"; d: string; opacity?: number }
  /** 实心方砖，使用 currentColor。 */
  | { kind: "block"; d: string; opacity?: number }
  /** 新星，使用强调色。 */
  | { kind: "nova"; d: string };

export const ICON_GRID = 24;
export const ICON_STROKE = 1.75;

/** 内凹四芒星：中心 (x, y)，半径 r；k 越大星身越饱满，0 为尖细的星芒。 */
export function sparklePath(x: number, y: number, r: number, k = 0.12): string {
  const n = (v: number) => Number(v.toFixed(2));
  const c = r * k;
  return (
    `M${n(x)} ${n(y - r)}Q${n(x + c)} ${n(y - c)} ${n(x + r)} ${n(y)}` +
    `Q${n(x + c)} ${n(y + c)} ${n(x)} ${n(y + r)}` +
    `Q${n(x - c)} ${n(y + c)} ${n(x - r)} ${n(y)}` +
    `Q${n(x - c)} ${n(y - c)} ${n(x)} ${n(y - r)}Z`
  );
}

/** 圆角方块路径；r 为 0 时是直角。 */
export function boxPath(x: number, y: number, w: number, h: number, r = 0): string {
  if (r <= 0) return `M${x} ${y}h${w}v${h}h${-w}Z`;
  const s = (v: number) => Number(v.toFixed(2));
  return (
    `M${s(x + r)} ${y}h${s(w - 2 * r)}a${r} ${r} 0 0 1 ${r} ${r}v${s(h - 2 * r)}` +
    `a${r} ${r} 0 0 1 ${-r} ${r}h${s(2 * r - w)}a${r} ${r} 0 0 1 ${-r} ${-r}v${s(2 * r - h)}a${r} ${r} 0 0 1 ${r} ${-r}Z`
  );
}

/** 圆形路径。 */
export function discPath(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
}

const stroke = (d: string, opacity?: number): IconPart => ({ kind: "stroke", d, ...(opacity === undefined ? {} : { opacity }) });
const block = (d: string, opacity?: number): IconPart => ({ kind: "block", d, ...(opacity === undefined ? {} : { opacity }) });
const nova = (d: string): IconPart => ({ kind: "nova", d });

/** 右上角“指数位”的新星，所有功能图标共用。 */
const exponent = nova(sparklePath(19, 5, 3.9));

export type IconName =
  | "spark"
  | "quill"
  | "constellation"
  | "facet"
  | "lens"
  | "orbit"
  | "folio"
  | "core"
  | "beacon"
  | "note";

export const ICONS: Record<IconName, { label: string; description: string; parts: IconPart[] }> = {
  spark: {
    label: "spark",
    description: "创作起步：一颗大星在方格里亮起，小星在指数位升起。",
    parts: [stroke(sparklePath(9.5, 14, 7.5, 0)), block(boxPath(8, 12.5, 3, 3, 0.7)), exponent],
  },
  quill: {
    label: "quill",
    description: "写作：稿页、两行字和一块正在输入的方砖。",
    parts: [
      stroke("M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"),
      stroke("M7 10h4M7 13.5h8"),
      block(boxPath(7, 16.4, 5, 2.2, 0.6)),
      exponent,
    ],
  },
  constellation: {
    label: "constellation",
    description: "故事：剧情方砖连成折线，终点指向新星。",
    parts: [
      stroke("M5.5 18.5L10 12.5l5 4 4-7.3"),
      block(boxPath(3.7, 16.7, 3.6, 3.6, 0.8)),
      block(boxPath(8.2, 10.7, 3.6, 3.6, 0.8)),
      block(boxPath(13.2, 14.7, 3.6, 3.6, 0.8)),
      exponent,
    ],
  },
  facet: {
    label: "facet",
    description: "元素：2×2 方砖格，三种状态各占一格，第四格让给新星。",
    parts: [
      stroke(boxPath(3.9, 5.9, 6.2, 6.2, 1.4)),
      block(boxPath(3, 14, 8, 8, 1.6)),
      block(boxPath(13, 14, 8, 8, 1.6), 0.4),
      exponent,
    ],
  },
  lens: {
    label: "lens",
    description: "资料：放大镜框住一块证据方砖。",
    parts: [stroke(discPath(10.5, 12.5, 6)), stroke("M15 17l5.5 4.5"), block(boxPath(8.5, 10.5, 4, 4, 0.8)), exponent],
  },
  orbit: {
    label: "orbit",
    description: "工作流：直角连线把方形节点串起来，输出是新星。",
    parts: [
      block(boxPath(2.5, 15.5, 6, 6, 1.4)),
      stroke("M5.5 15.5v-3H11M17 12.5h2v-3.1"),
      stroke(boxPath(11, 9.5, 6, 6, 1.4)),
      exponent,
    ],
  },
  folio: {
    label: "folio",
    description: "修订：叠放的稿页，其中一行被留存成方砖。",
    parts: [
      stroke("M7 8V6a2 2 0 0 1 2-2h4"),
      stroke("M19.5 12v7a2 2 0 0 1-2 2H16"),
      stroke(boxPath(3, 8, 13, 13, 2)),
      stroke("M6.5 12.5h6M6.5 15.5h3"),
      block(boxPath(10.5, 16.4, 3, 2.2, 0.5)),
      exponent,
    ],
  },
  core: {
    label: "core",
    description: "模型与服务：芯片中央一块核心方砖，右上角引脚让位给新星。",
    parts: [
      stroke(boxPath(5, 7, 12, 12, 2.5)),
      stroke("M2 11h3M2 15h3M9 19v3M13 19v3M9 4v3M13 4v3M17 12h3M17 16h3"),
      block(boxPath(9, 11, 4, 4, 0.8)),
      exponent,
    ],
  },
  beacon: {
    label: "beacon",
    description: "Provider：插头接入一条外部光源。",
    parts: [stroke("M8.5 3.5V8M12.5 3.5V8M5.5 8h10v3.5a5 5 0 0 1-10 0ZM10.5 16.5V21"), block(boxPath(9, 10.4, 3, 3, 0.6)), exponent],
  },
  note: {
    label: "note",
    description: "便签：折角的便签纸，一行字和一块方砖标记。",
    parts: [
      stroke("M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8l7-7v-2"),
      stroke("M13 21v-4a2 2 0 0 1 2-2h5"),
      stroke("M7 10h4"),
      block(boxPath(7, 13.2, 3, 3, 0.7)),
      exponent,
    ],
  },
};

/* ───────────────────────── 品牌记号 N² ───────────────────────── */

/** 记号画布 48×48，方格边长 6.4；N 占 5×5 方格（32×32），位于 (4, 12)。 */
export const MARK_VIEWBOX = 48;
export const MARK_CELL = 6.4;
export const MARK_GRID = 5;
export const MARK_ORIGIN = { x: 4, y: 12 } as const;

/** 新星指数：位于 N 右上外侧。 */
export const MARK_NOVA = sparklePath(40.2, 8.6, 7.4);

/** 左竖、阶梯对角、右竖三块，对应 Pi 标志把整体切成几块各自上色的做法。 */
export const MARK_PARTS = {
  left: "M4 12h6.4v32H4Z",
  diagonal: "M10.4 12H16.8V18.4H23.2V24.8H29.6V37.6H23.2V31.2H16.8V24.8H10.4Z",
  right: "M29.6 12H36v32h-6.4Z",
} as const;

export interface MarkPalette {
  left: string;
  diagonal: string;
  right: string;
  nova: string;
}

/** 浅色背景用的主配色：三块绿色深浅不同，新星是暖金。 */
export const MARK_COLOR: MarkPalette = { left: "#316357", diagonal: "#6c9a8a", right: "#254d44", nova: "#c8923a" };
/** 深绿应用图标底板上的配色。 */
export const MARK_ON_DARK: MarkPalette = { left: "#f4efe2", diagonal: "#e3b261", right: "#d8d2c0", nova: "#e3b261" };
/** 应用图标底板色与圆角（48 画布）。 */
export const APP_TILE = { fill: "#254d44", radius: 11 } as const;
