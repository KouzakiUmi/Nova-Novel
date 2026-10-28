import type { SVGProps } from "react";

/**
 * Nova Novel 图标集。
 * 统一 24 网格、1.6 描边、圆角端点；“新星”四芒星作为共同记号，
 * 以 currentColor 着色，强调色使用 --nova-accent（默认暖金）。
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  size?: number;
  strokeWidth?: number;
}

/** 内凹四芒星：中心 (x, y)，半径 r。 */
export function sparklePath(x: number, y: number, r: number): string {
  return `M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z`;
}

function Base({ size = 18, strokeWidth = 1.6, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

const accent = { fill: "var(--nova-accent, #c8923a)", stroke: "none" } as const;

/** 创作起步：一颗正在亮起的新星。 */
export function IconSpark(props: IconProps) {
  return (
    <Base {...props}>
      <path d={sparklePath(12, 12, 7.5)} />
      <path d="M12 2.2v1.2M12 20.6v1.2M2.2 12h1.2M20.6 12h1.2" opacity=".55" />
      <path d={sparklePath(18.6, 5.4, 1.9)} {...accent} />
    </Base>
  );
}

/** 写作：笔尖与落下的一点光。 */
export function IconQuill(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4.5 19.5l1-3.9L15.8 5.3a2.15 2.15 0 0 1 3 3L8.5 18.6z" />
      <path d="M13.9 7.2l3 3" />
      <path d="M12.5 20h7" />
      <path d={sparklePath(6.2, 6.2, 2.1)} {...accent} />
    </Base>
  );
}

/** 故事：剧情连成的星座。 */
export function IconConstellation(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M5 18l4.6-8.4 6.1 4.2L19 6.2" />
      <path d="M9.6 9.6L13 4.6" opacity=".55" />
      <circle cx="5" cy="18" r="1.7" />
      <circle cx="9.6" cy="9.6" r="1.7" />
      <circle cx="15.7" cy="13.8" r="1.7" />
      <circle cx="13" cy="4.6" r="1.1" opacity=".55" />
      <path d={sparklePath(19.2, 5.8, 2.6)} {...accent} />
    </Base>
  );
}

/** 元素：多面晶体，每一面是一个人物、物品或规则。 */
export function IconFacet(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" />
      <path d="M4.2 7.5L12 12l7.8-4.5M12 12v9" />
      <path d={sparklePath(12, 7.1, 1.6)} {...accent} />
    </Base>
  );
}

/** 资料：翻开的书与放大镜。 */
export function IconLens(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3 5.6c2.6-1 5.3-.8 8 .9V19c-2.7-1.6-5.4-1.9-8-.9z" />
      <path d="M11 6.5c1.6-1 3.2-1.4 4.9-1.3" />
      <circle cx="16.2" cy="13.2" r="3.6" />
      <path d="M18.8 15.8l2.4 2.4" />
      <path d={sparklePath(16.2, 13.2, 1.5)} {...accent} />
    </Base>
  );
}

/** 工作流：围绕中心运行的轨道。 */
export function IconOrbit(props: IconProps) {
  return (
    <Base {...props}>
      <ellipse cx="12" cy="12" rx="9.2" ry="4.3" transform="rotate(-28 12 12)" />
      <circle cx="4.6" cy="16" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="19.4" cy="8" r="1.5" />
      <path d={sparklePath(12, 12, 4.2)} {...accent} />
    </Base>
  );
}

/** 修订：叠放的稿页，每个留存版本都有标记。 */
export function IconFolio(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M8.5 3.8h8.2a2.3 2.3 0 0 1 2.3 2.3v8.4" />
      <rect x="4.5" y="7.6" width="11" height="12.8" rx="2.2" />
      <path d="M7.6 11.6h4.8M7.6 14.6h3" />
      <path d="M7.6 17.6h4.6" opacity=".55" />
      <path d={sparklePath(18.4, 18.4, 2.6)} {...accent} />
    </Base>
  );
}

/** 模型与服务：承载新星的核心芯片。 */
export function IconCore(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="5.5" y="5.5" width="13" height="13" rx="3.2" />
      <path d="M9.5 2.8v2.7M14.5 2.8v2.7M9.5 18.5v2.7M14.5 18.5v2.7M2.8 9.5h2.7M2.8 14.5h2.7M18.5 9.5h2.7M18.5 14.5h2.7" />
      <path d={sparklePath(12, 12, 3.6)} {...accent} />
    </Base>
  );
}

/** Provider：接入一条外部光源。 */
export function IconBeacon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M9 3.5v4M15 3.5v4" />
      <path d="M6.8 7.5h10.4v3.2a5.2 5.2 0 0 1-10.4 0z" />
      <path d="M12 15.9v4.6" />
      <path d={sparklePath(19.3, 18.3, 2)} {...accent} />
    </Base>
  );
}

/** 品牌记号：从书页中升起的新星。tone="mono" 时全部使用 currentColor。 */
export function NovaMark({ size = 32, tone = "color", ...rest }: Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number; tone?: "color" | "mono" }) {
  const ink = tone === "mono" ? "currentColor" : "var(--green, #316357)";
  const star = tone === "mono" ? "currentColor" : "var(--nova-accent, #c8923a)";
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false" {...rest}>
      <path d="M24 31.6c-4.6-3.1-10.3-3.9-16-2.1v9.4c5.7-1.8 11.4-1 16 2.1z" fill={ink} opacity=".9" />
      <path d="M24 31.6c4.6-3.1 10.3-3.9 16-2.1v9.4c-5.7-1.8-11.4-1-16 2.1z" fill={ink} opacity=".62" />
      <path d={sparklePath(24, 17.4, 11)} fill={star} />
      <path d={sparklePath(36.6, 9.4, 2.6)} fill={star} opacity=".72" />
      <path d={sparklePath(11.4, 13.2, 1.7)} fill={star} opacity=".5" />
    </svg>
  );
}
