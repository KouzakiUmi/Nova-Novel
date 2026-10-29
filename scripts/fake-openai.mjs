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
  if (guide.schema === 'nova-novel.element-design/1') {
    const type = guide.elementType ?? "character";
    if (type === "secret") {
      return JSON.stringify({
        cards: [
          {
            proposalId: "elem-1",
            type: "secret",
            name: "鞋跟暗格里的旧船票",
            aliases: ["旧船票秘密"],
            summary: "旧鞋鞋跟暗格里藏着一张二十年前未登船的旧船票，背面写着父亲的承诺。",
            differenceNote: "侧重亲情与过往亏欠",
            proposedFacts: [{ predicate: "category", value: "过往约定", semanticType: "world_fact" }],
            secret: {
              truth: "父亲当年为了留守修鞋铺，放弃了与老友远行的机会",
              falseBelief: "阿禾一直以为父亲从未离开过老街",
              initialHolders: ["父亲"],
              revealCondition: "当阿禾拆开那双待取旧鞋的后跟补线时",
            },
          },
          {
            proposalId: "elem-2",
            type: "secret",
            name: "借名修鞋的匿名托付",
            aliases: ["代名收据"],
            summary: "收据上的名字并非取鞋人本人，而是委托父亲代为保管遗物的暗记。",
            differenceNote: "侧重悬疑与身份错位",
            proposedFacts: [{ predicate: "category", value: "身份暗记", semanticType: "world_fact" }],
            secret: {
              truth: "取鞋人只是受托来确认阿禾是否平安的旧识",
              falseBelief: "表面上只是一桩拖延多年的普通修鞋生意",
              initialHolders: ["父亲"],
              revealCondition: "来人说出背面补线暗语的含义",
            },
          },
        ],
      });
    }
    if (type !== "character") {
      return JSON.stringify({
        cards: [
          {
            proposalId: "elem-1",
            type,
            name: "老街修鞋行规·留底收据",
            aliases: ["留底铁律"],
            summary: "凡标有“已付，待取”且背面写有双股麻线记号的收据，铺主在物主现身前不得关张销毁。",
            differenceNote: "强调手艺人契约与时间代价",
            proposedFacts: [{ predicate: "scope", value: "旧修鞋铺传承规矩", semanticType: "world_fact" }],
            world: {
              constraints: ["未取之物超过十年须转交继承人看管", "不得私自拆毁鞋底暗线"],
              sensoryDetails: ["泛黄发脆的毛边宣纸", "带着松香气息的麻线"],
              storyHooks: ["关店期限与未兑现收据形成直接冲突"],
            },
          },
          {
            proposalId: "elem-2",
            type,
            name: "钟楼西巷夜市旧档",
            aliases: ["西巷旧档"],
            summary: "修鞋铺所在的潮湿深巷，傍晚六点后只有修表匠与修鞋铺亮着黄铜台灯。",
            differenceNote: "强调空间氛围与邻里见证",
            proposedFacts: [{ predicate: "atmosphere", value: "潮湿安静的旧街巷", semanticType: "world_fact" }],
            world: {
              constraints: ["雨天巷尾积水，外来车辆无法通行"],
              sensoryDetails: ["青石板缝里的铁锈味", "远处钟楼整点沉闷的铜钟声"],
              storyHooks: ["街坊只记得那位顾客总在雨夜出现"],
            },
          },
        ],
      });
    }
    return JSON.stringify({
      cards: [
        {
          proposalId: "elem-1",
          type: "character",
          name: "沈伯",
          aliases: ["取鞋人", "老沈"],
          summary: "穿着旧呢子大衣的沉默老人，二十年前曾与父亲合开皮具作坊，因一次失信远走外埠。",
          differenceNote: "温和隐忍的旧友定位，冲突来自愧疚与迟到",
          proposedFacts: [
            { predicate: "role", value: "迟到的取鞋人", semanticType: "world_fact" },
            { predicate: "relation", value: { entityName: "父亲" }, semanticType: "world_fact" },
          ],
          arc: {
            motivation: "在彻底告别旧城前，确认老友留下的原谅",
            goal: "取回那双作为信物的旧皮鞋并向阿禾道出实情",
            conflict: "害怕阿禾得知当年自己连累父亲亏损的往事",
            epiphany: "明白隐瞒比坦白更伤人，决定把旧账本留给阿禾",
            notes: "说话慢，习惯先看鞋底针脚再开口",
          },
        },
        {
          proposalId: "elem-2",
          type: "character",
          name: "林岚",
          aliases: ["代取人", "林姐"],
          summary: "替母亲来取鞋的旧街邮差，手里握着半张对折的收据副联，说话干脆利落。",
          differenceNote: "同辈镜像定位，冲突来自两代人对留守的不同选择",
          proposedFacts: [
            { predicate: "occupation", value: "老街邮差", semanticType: "world_fact" },
            { predicate: "item_held", value: "半张收据副联", semanticType: "world_fact" },
          ],
          arc: {
            motivation: "替病中的母亲拿回年轻时的旧物",
            goal: "赶在修鞋铺清仓前核对收据背面的字迹",
            conflict: "收据年份与她所知的家庭记忆存在出入",
            epiphany: "与阿禾一起拼出父辈守口如瓶的互助往事",
            notes: "动作麻利，随身背着磨白帆布邮包",
          },
        },
      ],
    });
  }
  if (guide.schema === 'nova-novel.element-guide/1') {
    const mode = guide.mode;
    const stepId = guide.stepId;
    if (mode === "question") {
      return JSON.stringify({
        stepId,
        question: `围绕「${stepId}」，你希望这个设定朝哪个方向深入？`,
        why: "通过逐步收敛关键矛盾，让生成出的设定卡直接服务于场景戏剧冲突。",
        options: [
          { id: "opt_a", label: "温和克制但暗藏秘密", detail: "表面平静日常，冲突潜伏在旧物与未说出口的往事里" },
          { id: "opt_b", label: "直接对峙与现实压力", detail: "带着紧迫的时间限制或明确诉求进入修鞋铺" },
        ],
        allowCustom: true,
        allowSkip: true,
      });
    }
    return JSON.stringify({
      cards: [
        {
          proposalId: "elem-guide-1",
          type: guide.elementType ?? "character",
          name: "周师兄",
          aliases: ["老周", "守钟人"],
          summary: "经过问答引导生成的老街修表匠，曾替阿禾父亲保管那双旧皮鞋的备用鞋楦。",
          differenceNote: "结合引导答案定制的知情见证者",
          proposedFacts: [{ predicate: "role", value: "修鞋铺邻铺修表匠", semanticType: "world_fact" }],
          arc: {
            motivation: "守住对阿禾父亲生前的承诺",
            goal: "在阿禾关店前试探她是否准备好听真相",
            conflict: "既想帮阿禾解惑，又怕打破她平静的新生活",
            epiphany: "把备用鞋楦和旧信一并交出",
            notes: "引导共创生成",
          },
        },
      ],
    });
  }
  if (guide.schema === 'nova-novel.arc-assist/1') {
    if (guide.mode === "diagnose") {
      return JSON.stringify({
        progressSummary: "当前角色已完成起点阶段的情绪铺垫（发现旧收据并产生怀疑），但核心阻碍尚未在正文中正面爆发。",
        unfulfilledConflicts: ["尚未与取鞋人当面核对收据背面的补线叮嘱", "关店现实压力与追查旧事之间的取舍还未到最后期限"],
        nextDilemmaProposals: [
          {
            title: "收下转让定金还是再留三天",
            conflict: "盘铺子的买家要求今晚签字腾空，而取鞋人约好明早再来",
            choiceA: "按期签字关店，把旧鞋寄存在邻铺",
            choiceB: "推迟签约赔偿违约金，亲自等到取鞋人现身",
          },
        ],
      });
    }
    return JSON.stringify({
      proposals: [
        {
          proposalId: "arc-1",
          label: "释怀与传承线",
          differenceNote: "从急于摆脱旧铺子，转向理解父亲手艺背后的信义",
          motivation: "渴望卸下家庭旧物的负累，开始自己的生活",
          goal: "赶在租约到期前清点完最后一双待取旧鞋",
          conflict: "旧收据揭开父亲未曾提及的往事，让她无法草率关门",
          epiphany: "决定关掉实体店面，但带走父亲的修鞋工具与账本继续手艺",
          notes: "重在内心和解",
        },
        {
          proposalId: "arc-2",
          label: "追查真相线",
          differenceNote: "主动出击寻找收据主人，揭开老街二十年前的隐情",
          motivation: "弄清父亲为何执着保留这张无名收据",
          goal: "顺着补线手法找到当年的委托人",
          conflict: "知情街坊纷纷回避，线索指向她熟悉的亲人",
          epiphany: "直面父辈的遗憾，替父亲完成最后一次交接",
          notes: "重在行动推演",
        },
      ],
    });
  }
  if (guide.schema === 'nova-novel.plot-ideate/1') {
    if (guide.mode === "scene_brainstorm") {
      return JSON.stringify({
        fieldOptions: [
          { optionId: "opt-1", label: "物证反常", value: "收据背面夹着的铜扣刻着只有父亲才懂的年份缩写，而取鞋人却答不上来", rationale: "利用已有道具制造微观悬念" },
          { optionId: "opt-2", label: "时间紧迫", value: "房东提前上门收钥匙，阿禾必须在半小时内决定旧鞋去留", rationale: "增加外部现实时间压力" },
          { optionId: "opt-3", label: "情感试探", value: "来人一眼认出柜台下父亲用旧的锥子，却否认认识父亲本人", rationale: "通过言行矛盾推进人物张力" },
        ],
      });
    }
    return JSON.stringify({
      scenes: [
        {
          proposalId: "plot-scene-1",
          title: "雨夜核对针脚",
          goal: "阿禾想通过鞋底补线试探来人的真实身份",
          conflict: "来人只肯隔着柜台看鞋，拒绝留下姓名",
          summary: "阿禾借口还要再上一遍蜡，成功留对方在店里多坐半小时",
          pov: "阿禾",
          storyTime: "2",
          differenceNote: "承接前场悬念，聚焦店内对手戏",
        },
        {
          proposalId: "plot-scene-2",
          title: "邻铺修表匠的提醒",
          goal: "阿禾向隔壁老周打听二十年前的常客",
          conflict: "老周欲言又止，只提醒她先看鞋跟夹层",
          summary: "阿禾回到铺子拆开后跟，发现一张折起的旧字条",
          pov: "阿禾",
          storyTime: "3",
          differenceNote: "引入侧面知情人，推动物证发现",
        },
      ],
    });
  }
  if (guide.schema === 'nova-novel.note-incubate/1') {
    if (guide.targetKind === "scenes") {
      return JSON.stringify({
        sceneCards: [
          {
            proposalId: "inc-scene-1",
            title: "便签孵化：旧收据的回响",
            goal: "把零散灵感串联成阿禾与来人的第一次正面交锋",
            conflict: "收据字迹与来人叙述的年代前后矛盾",
            summary: "阿禾决定暂缓关店，先把鞋底暗线查清",
            differenceNote: "由所选便签串联生成的场景提案",
          },
        ],
      });
    }
    return JSON.stringify({
      elementCards: [
        {
          proposalId: "inc-elem-1",
          type: guide.targetKind === "character" ? "character" : "rule",
          name: guide.targetKind === "character" ? "陈木匠" : "双股麻线暗记",
          aliases: ["便签孵化设定"],
          summary: "由多条创作便签整合孵化出的核心设定，串联起旧修鞋铺的过往约定。",
          differenceNote: "融合便签细节的完整设定卡",
          proposedFacts: [{ predicate: "origin", value: "便签孵化", semanticType: "world_fact" }],
        },
      ],
    });
  }
  if (guide.schema === 'nova-novel.extract-ledger/1') {
    const userMsg = (body.messages ?? []).findLast((m) => m.role === "user")?.content ?? "";
    const textContent = typeof userMsg === "string" ? userMsg : JSON.stringify(userMsg);
    const bodySection = textContent.split("【当前正文】\n")[1]?.split("\n\n【选区】")[0] ?? "";
    const firstParagraph = bodySection.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)[0] ?? "那张旧收据夹在铁盒最底下";
    return JSON.stringify({
      newElements: [
        {
          proposalId: "ne-1",
          type: "item",
          name: "铁盒",
          aliases: ["旧铁盒"],
          summary: "柜台底下存放旧收据的铁盒。",
          quote: firstParagraph,
        },
      ],
      factProposals: [
        {
          proposalId: "fp-1",
          subjectName: "旧收据",
          predicate: "status",
          value: "已付，待取",
          semanticType: "world_fact",
          quote: firstParagraph,
        },
      ],
      eventProposals: [
        {
          proposalId: "ep-1",
          subjectName: "旧收据",
          kind: "item.check",
          fromValue: "铁盒最底下",
          toValue: "被阿禾翻出查看",
          quote: firstParagraph,
        },
      ],
    });
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
