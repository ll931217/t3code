import type { OrchestrationV2Subagent, ScopedThreadRef } from "@t3tools/contracts";

export interface AgentGraphThread {
  readonly ref: ScopedThreadRef;
  readonly parent?: ScopedThreadRef | null;
  readonly title: string;
  readonly status: string | null;
  readonly model?: string | null;
  readonly projectName?: string | null;
}

export interface AgentGraphNode {
  readonly key: string;
  readonly ref: ScopedThreadRef | null;
  readonly owner: ScopedThreadRef;
  readonly title: string;
  readonly objective: string | null;
  readonly status: string | null;
  readonly model: string | null;
  readonly projectName: string | null;
  readonly progress: string | null;
  readonly result: string | null;
  readonly missing: boolean;
  readonly depth: number;
  readonly parentKey: string | null;
}

export interface AgentExecutionGraph {
  readonly rootKey: string;
  readonly nodes: ReadonlyArray<AgentGraphNode>;
  readonly edges: ReadonlyArray<{ readonly source: string; readonly target: string }>;
}

const agentGraphThreadKey = (ref: ScopedThreadRef): string =>
  JSON.stringify([ref.environmentId, ref.threadId]);

export function deriveAgentExecutionGraph(input: {
  readonly root: ScopedThreadRef;
  readonly threads: ReadonlyArray<AgentGraphThread>;
  readonly projections: ReadonlyArray<{
    readonly owner: ScopedThreadRef;
    readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  }>;
}): AgentExecutionGraph {
  const rootKey = agentGraphThreadKey(input.root);
  const nodes = new Map<string, AgentGraphNode>();
  const parents = new Map<string, string>();
  const owners = new Map<string, string>();
  const connect = (parent: string, child: string) => {
    if (parent === child || child === rootKey) return;
    parents.set(child, parent);
  };
  const ensureThread = (ref: ScopedThreadRef) => {
    const key = agentGraphThreadKey(ref);
    if (!nodes.has(key)) {
      nodes.set(key, {
        key,
        ref,
        owner: ref,
        title: "Unavailable agent",
        objective: null,
        status: null,
        model: null,
        projectName: null,
        progress: null,
        result: null,
        missing: true,
        depth: 0,
        parentKey: null,
      });
    }
    return key;
  };
  ensureThread(input.root);
  for (const thread of input.threads) {
    const key = ensureThread(thread.ref);
    nodes.set(key, {
      ...nodes.get(key)!,
      title: thread.title,
      status: thread.status,
      model: thread.model ?? null,
      projectName: thread.projectName ?? null,
      missing: false,
    });
    if (thread.parent) connect(ensureThread(thread.parent), key);
  }
  for (const projection of input.projections) {
    const ownerKey = ensureThread(projection.owner);
    const taskKeys = new Map(
      projection.subagents.map((agent) => {
        const ref =
          agent.remoteChild ??
          (agent.childThreadId === null
            ? null
            : {
                environmentId: projection.owner.environmentId,
                threadId: agent.childThreadId,
              });
        const key =
          ref === null
            ? JSON.stringify([projection.owner.environmentId, projection.owner.threadId, agent.id])
            : ensureThread(ref);
        return [agent.id, { key, ref }] as const;
      }),
    );
    for (const agent of projection.subagents) {
      const { key, ref } = taskKeys.get(agent.id)!;
      const live = nodes.get(key);
      nodes.set(key, {
        key,
        ref,
        owner: projection.owner,
        title: live?.missing === false ? live.title : agent.title || "Agent",
        objective: agent.prompt || null,
        status: live?.missing === false ? (live.status ?? agent.status) : agent.status,
        model: live?.model ?? agent.model,
        projectName: live?.projectName ?? agent.remoteChild?.label ?? null,
        progress: agent.progress ?? null,
        result: agent.result,
        missing: ref !== null && live?.missing !== false,
        depth: 0,
        parentKey: null,
      });
      owners.set(key, ownerKey);
      const parentKey = taskKeys.get(agent.parentNodeId)?.key ?? ownerKey;
      connect(parentKey === key ? ownerKey : parentKey, key);
    }
  }
  const resolvedAncestry = new Set<string>();
  for (const key of owners.keys()) {
    const ancestors = new Set<string>();
    let ancestor: string | undefined = key;
    while (ancestor !== undefined && !resolvedAncestry.has(ancestor)) {
      if (ancestors.has(ancestor)) {
        const owner: string = owners.get(ancestor) ?? rootKey;
        const fallback: string = ancestors.has(owner) ? rootKey : owner;
        connect(fallback, ancestor);
        ancestor = fallback;
        continue;
      }
      ancestors.add(ancestor);
      ancestor = parents.get(ancestor);
    }
    for (const resolved of ancestors) resolvedAncestry.add(resolved);
  }
  const children = new Map<string, string[]>();
  for (const [child, parent] of parents) {
    const descendants = children.get(parent) ?? [];
    descendants.push(child);
    children.set(parent, descendants);
  }
  const visible: AgentGraphNode[] = [];
  const edges: { source: string; target: string }[] = [];
  const visited = new Set<string>([rootKey]);
  const queue = [{ key: rootKey, depth: 0, parentKey: null as string | null }];
  for (let index = 0; index < queue.length; index++) {
    const row = queue[index]!;
    const node = nodes.get(row.key);
    if (!node) continue;
    visible.push({ ...node, depth: row.depth, parentKey: row.parentKey });
    for (const child of children.get(row.key) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      edges.push({ source: row.key, target: child });
      queue.push({ key: child, depth: row.depth + 1, parentKey: row.key });
    }
  }
  return { rootKey, nodes: visible, edges };
}
