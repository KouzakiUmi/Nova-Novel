import type { SVGProps } from "react";
import {
  ICONS,
  ICON_GRID,
  ICON_STROKE,
  MARK_COLOR,
  MARK_NOVA,
  MARK_PARTS,
  MARK_VIEWBOX,
  sparklePath,
  type IconName,
} from "./iconGeometry";

export { sparklePath };

/**
 * Nova Novel 图标集「N² · 新星」。
 * 统一 24 网格、1.75 描边、直角为主的方砖几何；每个图标的主体里有一块实心方砖，
 * 右上角“指数位”固定是一颗新星。图形数据见 iconGeometry.ts，
 * 以 currentColor 着色，强调色使用 --nova-accent（默认暖金）。
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  size?: number;
  strokeWidth?: number;
}

function createIcon(name: IconName) {
  const { parts } = ICONS[name];
  return function Icon({ size = 18, strokeWidth = ICON_STROKE, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${ICON_GRID} ${ICON_GRID}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...rest}
      >
        {parts.map((part, index) => {
          if (part.kind === "stroke") return <path key={index} d={part.d} opacity={part.opacity} />;
          if (part.kind === "block") return <path key={index} d={part.d} fill="currentColor" stroke="none" opacity={part.opacity} />;
          return <path key={index} d={part.d} fill="var(--nova-accent, #c8923a)" stroke="none" />;
        })}
      </svg>
    );
  };
}

/** 创作起步：一颗正在亮起的新星。 */
export const IconSpark = createIcon("spark");
/** 写作：稿页、文字和正在输入的方砖。 */
export const IconQuill = createIcon("quill");
/** 故事：剧情方砖连成折线，终点指向新星。 */
export const IconConstellation = createIcon("constellation");
/** 元素：方砖格，每一格是一个人物、物品或规则。 */
export const IconFacet = createIcon("facet");
/** 资料：放大镜框住一块证据。 */
export const IconLens = createIcon("lens");
/** 工作流：直角连线把节点串向新星。 */
export const IconOrbit = createIcon("orbit");
/** 修订：叠放的稿页，留存的版本标成方砖。 */
export const IconFolio = createIcon("folio");
/** 模型与服务：芯片中央的核心方砖。 */
export const IconCore = createIcon("core");
/** Provider：接入一条外部光源。 */
export const IconBeacon = createIcon("beacon");
/** 便签：折角便签纸，尚未成形的想法。 */
export const IconNote = createIcon("note");

/**
 * 品牌记号 N²：5×5 方格拼成的 N，右上角指数位是新星。
 * tone="mono" 时全部使用 currentColor，三块靠不透明度区分。
 */
export function NovaMark({ size = 32, tone = "color", ...rest }: Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number; tone?: "color" | "mono" }) {
  const mono = tone === "mono";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`} aria-hidden="true" focusable="false" {...rest}>
      <path d={MARK_PARTS.left} fill={mono ? "currentColor" : "var(--green, #316357)"} />
      <path d={MARK_PARTS.diagonal} fill={mono ? "currentColor" : MARK_COLOR.diagonal} opacity={mono ? 0.6 : undefined} />
      <path d={MARK_PARTS.right} fill={mono ? "currentColor" : "var(--green-dark, #254d44)"} opacity={mono ? 0.85 : undefined} />
      <path d={MARK_NOVA} fill={mono ? "currentColor" : "var(--nova-accent, #c8923a)"} />
    </svg>
  );
}
