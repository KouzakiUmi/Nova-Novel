import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from "@nova-novel/shared";
import { stableHash } from "../utils.js";
import type { NodeTypeRegistry } from "./registry.js";
import type { WorkflowGraphFragment, WorkflowPortType } from "./types.js";

export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

/** 定义校验失败：包含全部问题，便于界面逐条说明。 */
export class WorkflowValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(`工作流定义校验失败：${issues.map((issue) => issue.message).join("；")}`);
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

function isCompatible(source: WorkflowPortType, target: WorkflowPortType): boolean {
  if (source === target) return true;
  if (source === "any" || target === "any") return true;
  return false;
}

/**
 * 语义哈希：排除画布坐标等纯布局信息，只对执行语义负责。
 */
export function semanticHash(definition: WorkflowDefinition): string {
  return stableHash({
    schemaVersion: definition.schemaVersion,
    workflowId: definition.workflowId,
    name: definition.name,
    description: definition.description,
    nodes: (definition.nodes ?? []).map((node) => ({
      id: node.id,
      type: node.type,
      typeVersion: node.typeVersion,
      name: node.name,
      config: node.config ?? {},
      inputs: node.inputs ?? {},
      outputs: node.outputs ?? {},
    })),
    edges: (definition.edges ?? []).map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.condition ? { condition: edge.condition } : {}),
    })),
    policy: definition.policy,
  });
}

/** 依赖图上的环检测，返回环路径；无环返回 null。 */
export function findCycle(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): string[] | null {
  const dependencies = new Map<string, Set<string>>();
  for (const node of nodes) {
    dependencies.set(node.id, new Set<string>());
  }
  for (const node of nodes) {
    const targets = dependencies.get(node.id);
    if (!targets) continue;
    for (const binding of Object.values(node.inputs ?? {})) {
      if (!("runInput" in binding)) targets.add(binding.node);
    }
  }
  for (const edge of edges) {
    const targets = dependencies.get(edge.target.node);
    if (targets) targets.add(edge.source.node);
  }

  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === "done") return null;
    if (current === "visiting") {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const next of dependencies.get(id) ?? []) {
      if (!dependencies.has(next)) continue;
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * 严格校验工作流定义：未知节点类型、端口类型、必填输入、连接一致性与拓扑环。
 */
export function validateDefinition(
  definition: WorkflowDefinition,
  registry: NodeTypeRegistry,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodes = definition.nodes ?? [];
  const edges = definition.edges ?? [];
  const nodeIds = new Set<string>();

  for (const node of nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({
        code: "duplicate_node",
        message: `节点 ID 重复：${node.id}`,
        nodeId: node.id,
      });
    }
    nodeIds.add(node.id);
  }

  for (const node of nodes) {
    const spec = registry.get(node.type, node.typeVersion);
    if (!spec) {
      issues.push({
        code: "unknown_node_type",
        message: `未知节点类型：${node.type}@${node.typeVersion}`,
        nodeId: node.id,
      });
      continue;
    }

    for (const [port, binding] of Object.entries(node.inputs ?? {})) {
      const inputSpec = spec.inputs[port];
      if (!inputSpec) {
        issues.push({
          code: "unknown_input_port",
          message: `节点 ${node.id} 声明了未登记的输入端口 ${port}`,
          nodeId: node.id,
        });
        continue;
      }
      if (!("runInput" in binding) && !nodeIds.has(binding.node)) {
        issues.push({
          code: "unknown_binding",
          message: `节点 ${node.id} 的输入 ${port} 指向不存在的节点 ${binding.node}`,
          nodeId: node.id,
        });
      }
    }

    for (const [port, inputSpec] of Object.entries(spec.inputs)) {
      if (!inputSpec.required) continue;
      if (!node.inputs || !(port in node.inputs)) {
        issues.push({
          code: "missing_required_input",
          message: `节点 ${node.id} 缺少必填输入 ${port}`,
          nodeId: node.id,
        });
      }
    }

    const expectedOutputs = registry.outputsOf(spec, node.config ?? {});
    for (const [port, outputSpec] of Object.entries(expectedOutputs)) {
      const declared = node.outputs?.[port];
      if (declared !== outputSpec.type) {
        issues.push({
          code: "output_type_mismatch",
          message: `节点 ${node.id} 的输出 ${port} 应为 ${outputSpec.type}，实际 ${String(declared)}`,
          nodeId: node.id,
        });
      }
    }
    for (const port of Object.keys(node.outputs ?? {})) {
      if (!(port in expectedOutputs)) {
        issues.push({
          code: "unknown_output_port",
          message: `节点 ${node.id} 声明了未登记的输出端口 ${port}`,
          nodeId: node.id,
        });
      }
    }
  }

  for (const edge of edges) {
    const source = nodes.find((node) => node.id === edge.source.node);
    const target = nodes.find((node) => node.id === edge.target.node);
    if (!source) {
      issues.push({
        code: "unknown_edge_source",
        message: `连接 ${edge.id} 的来源节点不存在：${edge.source.node}`,
        edgeId: edge.id,
      });
      continue;
    }
    if (!target) {
      issues.push({
        code: "unknown_edge_target",
        message: `连接 ${edge.id} 的目标节点不存在：${edge.target.node}`,
        edgeId: edge.id,
      });
      continue;
    }
    const sourceSpec = registry.get(source.type, source.typeVersion);
    const targetSpec = registry.get(target.type, target.typeVersion);

    if (sourceSpec) {
      const sourceOutputs = registry.outputsOf(sourceSpec, source.config ?? {});
      const declared = sourceOutputs[edge.source.port];
      if (!declared) {
        issues.push({
          code: "unknown_source_port",
          message: `连接 ${edge.id} 引用了来源节点 ${source.id} 不存在的输出 ${edge.source.port}`,
          edgeId: edge.id,
        });
      } else if (declared.type !== edge.source.type) {
        issues.push({
          code: "port_type_mismatch",
          message: `连接 ${edge.id} 的来源端口 ${edge.source.port} 类型应为 ${declared.type}，实际 ${edge.source.type}`,
          edgeId: edge.id,
        });
      }
    }

    if (edge.condition !== undefined) {
      // 条件连接只负责激活分支，不承载数据。
      if (edge.target.port !== "control") {
        issues.push({
          code: "invalid_control_edge",
          message: `条件连接 ${edge.id} 的目标端口必须是 control`,
          edgeId: edge.id,
        });
      }
      if (edge.source.port !== edge.condition) {
        issues.push({
          code: "invalid_control_edge",
          message: `条件连接 ${edge.id} 的来源端口必须与条件 ${edge.condition} 一致`,
          edgeId: edge.id,
        });
      }
      continue;
    }

    if (targetSpec) {
      const targetInput = targetSpec.inputs[edge.target.port];
      if (!targetInput) {
        issues.push({
          code: "unknown_target_port",
          message: `连接 ${edge.id} 指向目标节点 ${target.id} 不存在的输入端口 ${edge.target.port}`,
          edgeId: edge.id,
        });
      } else {
        if (!isCompatible(edge.source.type, targetInput.type)) {
          issues.push({
            code: "port_type_mismatch",
            message: `连接 ${edge.id} 的端口类型不匹配：${edge.source.type} → ${targetInput.type}`,
            edgeId: edge.id,
          });
        }
        const binding = target.inputs?.[edge.target.port];
        const consistent =
          binding !== undefined &&
          !("runInput" in binding) &&
          binding.node === edge.source.node &&
          binding.port === edge.source.port;
        if (!consistent) {
          issues.push({
            code: "binding_mismatch",
            message: `连接 ${edge.id} 与节点 ${target.id} 的输入映射不一致`,
            edgeId: edge.id,
          });
        }
      }
    }

    if (!isCompatible(edge.source.type, edge.target.type)) {
      issues.push({
        code: "port_type_mismatch",
        message: `连接 ${edge.id} 的输出与输入类型不匹配：${edge.source.type} → ${edge.target.type}`,
        edgeId: edge.id,
      });
    }
  }

  const cycle = findCycle(nodes, edges);
  if (cycle) {
    issues.push({
      code: "cycle",
      message: `工作流存在环：${cycle.join(" → ")}`,
    });
  }

  // 受控遍历容器内的子流程同样需要通过校验。
  for (const node of nodes) {
    const spec = registry.get(node.type, node.typeVersion);
    if (!spec || spec.kind !== "foreach") continue;
    const child = (node.config as { child?: WorkflowGraphFragment }).child;
    if (!child) {
      issues.push({
        code: "missing_child",
        message: `遍历容器 ${node.id} 缺少子流程定义`,
        nodeId: node.id,
      });
      continue;
    }
    for (const childNode of child.nodes) {
      const childSpec = registry.get(childNode.type, childNode.typeVersion);
      if (childSpec?.kind === "human") {
        issues.push({
          code: "human_in_foreach",
          message: `遍历容器 ${node.id} 内不支持人工节点 ${childNode.id}`,
          nodeId: node.id,
        });
      }
    }
    const childDefinition: WorkflowDefinition = {
      schemaVersion: definition.schemaVersion,
      workflowId: `${definition.workflowId}.child.${node.id}`,
      workflowVersionId: `${definition.workflowVersionId}.child.${node.id}`,
      name: `${definition.name}（${node.name}）`,
      description: definition.description,
      nodes: child.nodes,
      edges: child.edges,
      policy: definition.policy,
    };
    for (const childIssue of validateDefinition(childDefinition, registry)) {
      issues.push({
        code: childIssue.code,
        message: `遍历容器 ${node.id}：${childIssue.message}`,
        nodeId: node.id,
      });
    }
  }

  return issues;
}
