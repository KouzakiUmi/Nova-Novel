import type { Chapter, IdeaCardFields, Scene, StoryGraph, FactAssertion } from "@nova-novel/shared";
import { newId, now, stableHash } from "./utils.js";

export class DomainError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly currentRevisionId?: string,
    public readonly selectionVersion?: number,
  ) { super(message); this.name = "DomainError"; }
}

export interface RevisionManifest {
  chapters: Chapter[];
  scenes: Scene[];
  storyGraph: StoryGraph;
  facts: FactAssertion[];
  writingIntent: Record<string, unknown>;
}

export function requiredString(value: unknown, name: string, max = 100_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new DomainError(400, "INVALID_INPUT", `${name} 必须是非空文字（最多 ${max} 字符）`);
  }
  return value;
}
export function versionNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new DomainError(400, "INVALID_INPUT", "selectionVersion 必须是非负整数");
  return Number(value);
}
export function cardKey(ref: { cardId: string; cardRevision: number }): string { return `${ref.cardId}:${ref.cardRevision}`; }
export function planHash(manifest: RevisionManifest): string {
  return stableHash({
    scenes: manifest.scenes.map(({ sceneId, summary, goal, conflict, pov, storyTime, narrationOrder, routeId, entityIds }) => ({ sceneId, summary, goal, conflict, pov, storyTime, narrationOrder, routeId, entityIds })),
    nodes: manifest.storyGraph.nodes.map(({ position: _position, ...node }) => node),
    edges: manifest.storyGraph.edges,
  });
}

export const EXAMPLE_IDEAS: IdeaCardFields[] = [
  { action: "关门前，阿禾替一张三十年前的收据把鞋修好", motivation: "她答应父亲，今天结清铺里的每一笔旧账", obstacle: "取鞋的人带来的收据，落款却是明天", outcome: "阿禾仍然关店，但把鞋交给一个愿意讲清来历的人", focus: "一张小票怎样让一个陌生人留下来", tradeoff: "谜团缓慢展开，先写两个人的试探，而不急着揭底" },
  { action: "阿禾把收据贴在最后一天的橱窗，请街坊认领那双鞋", motivation: "她不愿把父亲替别人保管的东西当废物卖掉", obstacle: "两个街坊都说鞋属于自己，却都避开同一道补线", outcome: "她仍然关店，带着那双没人真正认领的鞋去找原主人", focus: "熟悉街坊之间不肯说出的亏欠", tradeoff: "多一组人物关系，收据上的时间谜题退到背景" },
  { action: "阿禾决定不查收据，把修好的鞋送到上面的旧地址", motivation: "她想让最后一桩活有个交代，再离开这条街", obstacle: "地址如今是一座水塔，门卫却一直等着有人送鞋", outcome: "她仍然关店，送鞋这趟路成为离开的第一站", focus: "主动出门，以行动发现旧事", tradeoff: "更快进入外部空间，少一些铺内对话与修鞋细节" },
];

export function initialManifest(projectId: string, routeId: string, example: boolean): RevisionManifest {
  const chapterId = newId("chapter");
  const sceneId = newId("scene");
  const chapters: Chapter[] = [{ chapterId, projectId, title: example ? "第一章 · 最后一桩活" : "第一章", order: 1 }];
  const scenes: Scene[] = [{
    sceneId, projectId, chapterId, title: example ? "关门前的收据" : "第一场戏",
    summary: example ? "阿禾准备关掉父亲留下的修鞋铺，一张旧收据让最后一桩活变得不寻常。" : "",
    body: example ? "阿禾把最后一只鞋楦收进纸箱，卷帘门外的雨还没停。\n\n柜台底下卡着一张收据。纸黄了，红色印章倒很清楚：已付，待取。她翻过来，背面写着一行小字——右脚内侧，请多缝一道。\n\n她认得父亲的字。可那双鞋她今天才第一次见。\n\n门铃响的时候，她正把针穿进那道旧线孔。来人没有收伞，只问：‘还来得及吗？’\n\n‘修鞋来得及。’阿禾把收据压在玻璃下面，‘取鞋得先告诉我，你等了多久。’" : "",
    status: "draft", narrationOrder: 1, routeId, entityIds: [], baseRevisionId: "", updatedAt: now(),
    ...(example ? { pov: "阿禾", goal: "结清旧账，按时关店", conflict: "一张旧收据与刚出现的鞋对不上" } : {}),
  }];
  return {
    chapters, scenes, facts: [], writingIntent: {},
    storyGraph: { projectId, revisionId: "", nodes: [
      { id: sceneId, kind: "scene", sceneId, title: scenes[0]!.title, summary: scenes[0]!.summary, position: { x: 80, y: 120 } },
      ...(example ? [{ id: newId("plot"), kind: "note" as const, title: "收据从哪里来？", summary: "待探索的故事问题，尚未决定答案。", position: { x: 410, y: 120 } }] : []),
    ], edges: [] },
  };
}
