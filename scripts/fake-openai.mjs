// 本机验收用的 OpenAI 兼容假服务：按请求中的任务提示返回固定产物，不连接外部网络。
import { createServer } from "node:http";

const port = Number(process.env.FAKE_OPENAI_PORT ?? 43190);

function guideInput(body) {
  const texts = (body.messages ?? []).filter(message => message.role === "user").flatMap(message => {
    if (typeof message.content === "string") return [message.content];
    if (Array.isArray(message.content)) return message.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text);
    return [];
  });
  const text = texts.findLast(value => value.includes("作者本次要求：")) ?? "";
  const raw = text.split("作者本次要求：")[1]?.split(/\n\n【作品与作者意图】/)[0];
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function reply(body) {
  const system = (body.messages ?? []).map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
  const guide = guideInput(body);
  if (guide.schema === 'nova-novel.workflow-guide/1') {
    const guideStep = guide.stepId;
    if (guideStep === 'intent') return JSON.stringify({ stepId: "intent", question: "这个流程要怎样帮助当前场景？", why: "写作意图会进入生成节点，决定候选怎样形成。", options: [{ id: "action", label: "推进事件", detail: "围绕目标、阻碍和预期变化生成候选" }, { id: "reaction", label: "反应与决定", detail: "让人物处理已经发生的事并形成下一步决定" }], allowCustom: true, allowSkip: true });
    if (guideStep === 'review') return JSON.stringify({ stepId: "review", question: "候选生成后，要加入一致性检查吗？", why: "检查只形成报告，正文提交始终需要作者人工决定。", options: [{ id: "checked", label: "先检查，再由我审阅", detail: "生成候选后先做一致性检查，再打开人工审阅" }, { id: "review-only", label: "只由我本人审阅", detail: "不增加自动检查节点，直接预览候选并决定是否提交" }], allowCustom: true, allowSkip: false });
    if (guideStep === 'proposal') return JSON.stringify({ schemaVersion: "nova-novel.workflow/1", name: "交互式场景工作流", description: "按作者选择的意图生成候选，经人工审阅后提交，不在发布时自动运行。", nodes: [
      { id: "scene", type: "run.scene", typeVersion: 1, name: "选择场景", config: {}, inputs: { scene: { runInput: "sceneId" } }, outputs: { scene: "SceneRef" }, ui: { x: 40, y: 100 } },
      { id: "state", type: "world.readState", typeVersion: 1, name: "读取状态", config: {}, inputs: { scene: { node: "scene", port: "scene" } }, outputs: { state: "WorldState" }, ui: { x: 240, y: 100 } },
      { id: "retrieve", type: "context.retrieve", typeVersion: 1, name: "检索上下文", config: { purpose: "scene_writing" }, inputs: { scene: { node: "scene", port: "scene" }, state: { node: "state", port: "state" } }, outputs: { context: "ContextBundle" }, ui: { x: 440, y: 100 } },
      { id: "generate", type: "agent.generate", typeVersion: 1, name: "生成候选", config: { kind: "scene", prompt: "按作者选择的写作意图生成候选" }, inputs: { context: { node: "retrieve", port: "context" } }, outputs: { draft: "DraftArtifact" }, ui: { x: 640, y: 100 } },
      { id: "review", type: "human.review", typeVersion: 1, name: "作者审阅", config: { question: "是否接受这份候选？" }, inputs: { candidate: { node: "generate", port: "draft" } }, outputs: { decision: "DecisionRecord" }, ui: { x: 840, y: 100 } },
      { id: "commit", type: "revision.commit", typeVersion: 1, name: "提交修订", config: {}, inputs: { decision: { node: "review", port: "decision" }, draft: { node: "generate", port: "draft" } }, outputs: { revision: "RevisionRef" }, ui: { x: 1040, y: 100 } },
    ], edges: [
      { id: "e1", source: { node: "scene", port: "scene", type: "SceneRef" }, target: { node: "state", port: "scene", type: "SceneRef" } },
      { id: "e2", source: { node: "scene", port: "scene", type: "SceneRef" }, target: { node: "retrieve", port: "scene", type: "SceneRef" } },
      { id: "e3", source: { node: "state", port: "state", type: "WorldState" }, target: { node: "retrieve", port: "state", type: "WorldState" } },
      { id: "e4", source: { node: "retrieve", port: "context", type: "ContextBundle" }, target: { node: "generate", port: "context", type: "ContextBundle" } },
      { id: "e5", source: { node: "generate", port: "draft", type: "DraftArtifact" }, target: { node: "review", port: "candidate", type: "DraftArtifact" } },
      { id: "e6", source: { node: "review", port: "decision", type: "DecisionRecord" }, target: { node: "commit", port: "decision", type: "DecisionRecord" } },
      { id: "e7", source: { node: "generate", port: "draft", type: "DraftArtifact" }, target: { node: "commit", port: "draft", type: "DraftArtifact" } },
    ], policy: { maxParallelNodes: 2, maxNodeAttempts: 2, maxIterations: 2 } });
  }
  if (guide.schema === 'nova-novel.guide/1') {
    const guideStep = guide.stepId;
    if (guideStep === 'proposal') return JSON.stringify({ scenes: [
      { proposalId: "scene-1", title: "把旧收据问清楚", goal: "阿禾想弄清取鞋人的来历", conflict: "来人避谈收据年份", summary: "她决定先听完对方的解释，关店计划不变" },
      { proposalId: "scene-2", title: "父亲的补线手法", goal: "阿禾想确认补线是否出自父亲", conflict: "父亲不愿谈那位老顾客", summary: "她发现父亲也曾替同一个人修过鞋" },
      { proposalId: "scene-3", title: "最后一次取鞋", goal: "阿禾决定按约定交还旧鞋", conflict: "取鞋时间和关店安排冲突", summary: "她仍按计划关店，但替这段旧关系留下一个答案" },
    ] });
    if (guideStep === 'conflict') return JSON.stringify({ stepId: "conflict", question: "什么让这件事不容易？", why: "阻碍会迫使人物作出选择，而不是只交代背景。", options: [{ id: "silent", label: "来人不肯说出名字", detail: "阿禾必须决定追问还是让对方保留秘密" }, { id: "father", label: "父亲回避这段往事", detail: "她需要在关店安排和弄清真相之间分配时间" }], allowCustom: true, allowSkip: true });
    if (guideStep === 'outcome') return JSON.stringify({ stepId: "outcome", question: "这一段结束时，什么发生了变化？", why: "结果让场景产生方向，也能帮助下一场自然开始。", options: [{ id: "listen", label: "决定先听完", detail: "阿禾暂时不追问，但愿意给对方一次解释机会" }, { id: "return", label: "决定交还旧鞋", detail: "她开始主动寻找取鞋人，故事从疑问转向行动" }], allowCustom: true, allowSkip: true });
    return JSON.stringify({ stepId: "goal", question: "主角此刻最想完成什么？", why: "先确定一个能在场景里行动的小目标，不需要想清整本书。", options: [{ id: "receipt", label: "弄清旧收据的来历", detail: "从眼前最具体的疑问开始行动" }, { id: "close", label: "按时关掉修鞋铺", detail: "先完成现实目标，让旧物成为阻碍" }], allowCustom: true, allowSkip: true });
  }
  if (system.includes('cards')) {
    return JSON.stringify({ cards: [
      { action: "阿禾把收据夹进账本，决定先修鞋再问来历", motivation: "她想把最后一桩活做完", obstacle: "来人不肯说出收据上的名字", outcome: "她仍然关店，但留下了来人的电话", focus: "沉默里的试探", tradeoff: "节奏慢，悬念留到下一场" },
      { action: "阿禾按收据背面的叮嘱补线，补到一半发现旧线不是父亲的手法", motivation: "她认得父亲的针脚", obstacle: "补线的人另有其人", outcome: "她把鞋暂留在店里", focus: "手艺里的证据", tradeoff: "多一个隐藏人物" },
      { action: "阿禾直接问来人等了多久", motivation: "她不想绕弯", obstacle: "来人说出的年份比收据还早", outcome: "两人约定明天再见", focus: "直接对话的张力", tradeoff: "谜团更早摊开" },
    ] });
  }
  if (system.includes('反应、两难与决定')) return "阿禾把收据重新压回玻璃下。直接追问只会让对方转身离开，继续修鞋又像是故意逃避。\n\n她把针脚放慢，决定先听来人把话说完。";
  if (system.includes('replacement')) return JSON.stringify({ replacement: "她认得父亲的字，一笔一画都像他补鞋时那样不肯松。", proposals: [] });
  if (system.includes('issues')) return JSON.stringify({ summary: "未发现与已确认设定冲突的内容。", issues: [{ severity: "unknown", title: "来人身份未定", detail: "正文未交代来人与父亲的关系，这是留白而非错误。", evidence: [] }] });
  return "门铃又响了一次。阿禾没有抬头，只把针从旧线孔里慢慢拉出来。\n\n“鞋修好之前，”她说，“你可以先坐。”";
}

createServer((request, response) => {
  if (request.method === "GET" && request.url?.endsWith("/models")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "nova-writer" }, { id: "nova-checker" }] }));
    return;
  }
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    const text = reply(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    const pieces = text.match(/[\s\S]{1,24}/g) ?? [""];
    pieces.forEach((piece, index) => send({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: index === 0 ? { role: "assistant", content: piece } : { content: piece } }] }));
    send({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    response.end("data: [DONE]\n\n");
  });
}).listen(port, "127.0.0.1", () => console.log(`fake openai at http://127.0.0.1:${port}/v1`));
