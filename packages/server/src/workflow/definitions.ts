import type { WorkflowDefinition } from "@nova-novel/shared";
import type { WorkflowGraphFragment } from "./types.js";

/** 场景创作流程的子流程（受控遍历内逐场景核对）。 */
const auditSceneFragment: WorkflowGraphFragment = {
  nodes: [
    {
      id: "item_state",
      type: "world.readState",
      typeVersion: 1,
      name: "还原场景状态",
      config: {},
      inputs: { scene: { runInput: "item" } },
      outputs: { state: "WorldState" },
      ui: { x: 40, y: 40 },
    },
    {
      id: "item_check",
      type: "quality.checkScene",
      typeVersion: 1,
      name: "检查场景事实",
      config: {},
      inputs: {
        scene: { runInput: "item" },
        state: { node: "item_state", port: "state" },
      },
      outputs: { report: "IssueReport" },
      ui: { x: 260, y: 40 },
    },
  ],
  edges: [
    {
      id: "item_edge_state_check",
      source: { node: "item_state", port: "state", type: "WorldState" },
      target: { node: "item_check", port: "state", type: "WorldState" },
    },
  ],
};

/** 默认场景创作流程：读取状态 → 检索 → 生成 → 一致性检查 → 人工审阅 → 提交。 */
export function sceneCreationDefinition(): WorkflowDefinition {
  return {
    schemaVersion: "nova-novel.workflow/1",
    workflowId: "wf_scene_create",
    workflowVersionId: "wfv_scene_create_1",
    name: "场景创作",
    description:
      "选择场景后读取元素状态并检索上下文，生成候选稿，做一致性检查，经作者人工接受后提交修订。",
    nodes: [
      {
        id: "scene",
        type: "run.scene",
        typeVersion: 1,
        name: "选择场景",
        config: {},
        inputs: { scene: { runInput: "sceneId" } },
        outputs: { scene: "SceneRef" },
        ui: { x: 40, y: 120 },
      },
      {
        id: "state",
        type: "world.readState",
        typeVersion: 1,
        name: "读取元素状态",
        config: {},
        inputs: { scene: { node: "scene", port: "scene" } },
        outputs: { state: "WorldState" },
        ui: { x: 260, y: 120 },
      },
      {
        id: "retrieve",
        type: "context.retrieve",
        typeVersion: 1,
        name: "检索上下文",
        config: { purpose: "scene_writing", maxEvidenceItems: 12 },
        inputs: {
          scene: { node: "scene", port: "scene" },
          state: { node: "state", port: "state" },
        },
        outputs: { context: "ContextBundle" },
        ui: { x: 480, y: 120 },
      },
      {
        id: "generate",
        type: "agent.generate",
        typeVersion: 1,
        name: "生成内容",
        config: { kind: "scene", prompt: "依据检索到的上下文生成该场景的候选正文。" },
        inputs: { context: { node: "retrieve", port: "context" } },
        outputs: { draft: "DraftArtifact" },
        ui: { x: 700, y: 120 },
      },
      {
        id: "check",
        type: "quality.checkConsistency",
        typeVersion: 1,
        name: "一致性检查",
        config: {},
        inputs: {
          draft: { node: "generate", port: "draft" },
          context: { node: "retrieve", port: "context" },
        },
        outputs: { report: "IssueReport" },
        ui: { x: 920, y: 120 },
      },
      {
        id: "review",
        type: "human.review",
        typeVersion: 1,
        name: "人工审阅",
        config: { question: "是否接受这一版候选正文？" },
        inputs: {
          candidate: { node: "generate", port: "draft" },
          report: { node: "check", port: "report" },
        },
        outputs: { decision: "DecisionRecord" },
        ui: { x: 1140, y: 120 },
      },
      {
        id: "commit",
        type: "revision.commit",
        typeVersion: 1,
        name: "提交修订",
        config: {},
        inputs: {
          decision: { node: "review", port: "decision" },
          draft: { node: "generate", port: "draft" },
        },
        outputs: { revision: "RevisionRef" },
        ui: { x: 1360, y: 120 },
      },
    ],
    edges: [
      {
        id: "edge_scene_state",
        source: { node: "scene", port: "scene", type: "SceneRef" },
        target: { node: "state", port: "scene", type: "SceneRef" },
      },
      {
        id: "edge_state_retrieve",
        source: { node: "state", port: "state", type: "WorldState" },
        target: { node: "retrieve", port: "state", type: "WorldState" },
      },
      {
        id: "edge_scene_retrieve",
        source: { node: "scene", port: "scene", type: "SceneRef" },
        target: { node: "retrieve", port: "scene", type: "SceneRef" },
      },
      {
        id: "edge_retrieve_generate",
        source: { node: "retrieve", port: "context", type: "ContextBundle" },
        target: { node: "generate", port: "context", type: "ContextBundle" },
      },
      {
        id: "edge_generate_check",
        source: { node: "generate", port: "draft", type: "DraftArtifact" },
        target: { node: "check", port: "draft", type: "DraftArtifact" },
      },
      {
        id: "edge_retrieve_check",
        source: { node: "retrieve", port: "context", type: "ContextBundle" },
        target: { node: "check", port: "context", type: "ContextBundle" },
      },
      {
        id: "edge_generate_review",
        source: { node: "generate", port: "draft", type: "DraftArtifact" },
        target: { node: "review", port: "candidate", type: "DraftArtifact" },
      },
      {
        id: "edge_check_review",
        source: { node: "check", port: "report", type: "IssueReport" },
        target: { node: "review", port: "report", type: "IssueReport" },
      },
      {
        id: "edge_review_commit",
        source: { node: "review", port: "decision", type: "DecisionRecord" },
        target: { node: "commit", port: "decision", type: "DecisionRecord" },
      },
      {
        id: "edge_generate_commit",
        source: { node: "generate", port: "draft", type: "DraftArtifact" },
        target: { node: "commit", port: "draft", type: "DraftArtifact" },
      },
    ],
    policy: { maxParallelNodes: 2, maxNodeAttempts: 2, maxIterations: 2 },
  };
}

/** 全卷逻辑巡检流程：冻结版本 → 受控遍历场景 → 合并问题 → 作者处理。 */
export function volumeAuditDefinition(): WorkflowDefinition {
  return {
    schemaVersion: "nova-novel.workflow/1",
    workflowId: "wf_volume_audit",
    workflowVersionId: "wfv_volume_audit_1",
    name: "全卷逻辑巡检",
    description:
      "冻结本卷版本后按上限遍历场景，逐场景核对事实并合并问题单，交作者处理，不自动改正文。",
    nodes: [
      {
        id: "freeze",
        type: "run.freezeRevision",
        typeVersion: 1,
        name: "冻结本卷版本",
        config: {},
        inputs: {},
        outputs: { revision: "RevisionRef" },
        ui: { x: 40, y: 120 },
      },
      {
        id: "scenes",
        type: "run.sceneList",
        typeVersion: 1,
        name: "选择巡检场景",
        config: {},
        inputs: { sceneIds: { runInput: "sceneIds" } },
        outputs: { scenes: "SceneRef" },
        ui: { x: 240, y: 120 },
      },
      {
        id: "audit",
        type: "flow.foreach",
        typeVersion: 1,
        name: "遍历场景检查",
        config: {
          maxItems: 8,
          maxIterations: 8,
          resultPort: "report",
          resultType: "IssueReport",
          child: auditSceneFragment,
        },
        inputs: { items: { node: "scenes", port: "scenes" } },
        outputs: { results: "IssueReport" },
        ui: { x: 440, y: 120 },
      },
      {
        id: "merge",
        type: "quality.mergeReports",
        typeVersion: 1,
        name: "合并问题单",
        config: {},
        inputs: { reports: { node: "audit", port: "results" } },
        outputs: { report: "IssueReport" },
        ui: { x: 640, y: 120 },
      },
      {
        id: "review",
        type: "human.review",
        typeVersion: 1,
        name: "作者处理问题单",
        config: { question: "这些巡检问题应如何处理？" },
        inputs: { candidate: { node: "merge", port: "report" } },
        outputs: { decision: "DecisionRecord" },
        ui: { x: 840, y: 120 },
      },
    ],
    edges: [
      {
        id: "edge_scenes_audit",
        source: { node: "scenes", port: "scenes", type: "SceneRef" },
        target: { node: "audit", port: "items", type: "SceneRef" },
      },
      {
        id: "edge_audit_merge",
        source: { node: "audit", port: "results", type: "IssueReport" },
        target: { node: "merge", port: "reports", type: "IssueReport" },
      },
      {
        id: "edge_merge_review",
        source: { node: "merge", port: "report", type: "IssueReport" },
        target: { node: "review", port: "candidate", type: "IssueReport" },
      },
    ],
    policy: { maxParallelNodes: 2, maxNodeAttempts: 2, maxIterations: 8 },
  };
}

/** 内置的不可变模板集合。 */
export function buildBuiltinDefinitions(): WorkflowDefinition[] {
  return [sceneCreationDefinition(), volumeAuditDefinition()];
}
