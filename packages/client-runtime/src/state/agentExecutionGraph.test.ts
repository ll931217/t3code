import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, NodeId, ThreadId, type OrchestrationV2Subagent } from "@t3tools/contracts";

import { deriveAgentExecutionGraph } from "./agentExecutionGraph.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const root = { environmentId: local, threadId: ThreadId.make("root") };

describe("agent execution graph", () => {
  it("keeps remote thread identities distinct and excludes unrelated conversations", () => {
    const graph = deriveAgentExecutionGraph({
      root,
      threads: [
        { ref: root, title: "Coordinate", status: "waiting" },
        {
          ref: { ...root, threadId: ThreadId.make("worker") },
          parent: root,
          title: "Local",
          status: "running",
        },
        {
          ref: { environmentId: remote, threadId: ThreadId.make("worker") },
          parent: root,
          title: "Remote",
          status: "completed",
        },
        {
          ref: { ...root, threadId: ThreadId.make("unrelated") },
          title: "Other",
          status: "running",
        },
      ],
      projections: [],
    });
    expect(graph.nodes.map((node) => [node.title, node.depth, node.status])).toEqual([
      ["Coordinate", 0, "waiting"],
      ["Local", 1, "running"],
      ["Remote", 1, "completed"],
    ]);
    expect(new Set(graph.nodes.map((node) => node.key)).size).toBe(3);
    expect(graph.edges).toHaveLength(2);
  });

  it("shows native nested spawns and an unavailable remote child without inventing threads", () => {
    const task = (id: string, parentNodeId: string, fields = {}) =>
      ({
        id: NodeId.make(id),
        parentNodeId: NodeId.make(parentNodeId),
        threadId: root.threadId,
        childThreadId: null,
        title: id,
        prompt: `Assignment ${id}`,
        model: "model",
        status: "running",
        result: null,
        ...fields,
      }) as OrchestrationV2Subagent;
    const graph = deriveAgentExecutionGraph({
      root,
      threads: [
        { ref: root, title: "Root", status: "running" },
        {
          ref: { ...root, threadId: ThreadId.make("nested-thread") },
          parent: root,
          title: "Nested worker",
          status: null,
        },
      ],
      projections: [
        {
          owner: root,
          subagents: [
            task("native", "root-run"),
            task("nested", "native"),
            task("nested-worker", "native", { childThreadId: ThreadId.make("nested-thread") }),
            task("elsewhere", "root-run", {
              remoteChild: { environmentId: remote, threadId: "remote-child", label: "Laptop" },
            }),
          ],
        },
      ],
    });
    expect(graph.nodes.map((node) => [node.title, node.depth])).toEqual([
      ["Root", 0],
      ["native", 1],
      ["elsewhere", 1],
      ["Nested worker", 2],
      ["nested", 2],
    ]);
    expect(graph.nodes.find((node) => node.title === "native")?.ref).toBeNull();
    expect(graph.nodes.find((node) => node.title === "elsewhere")?.ref?.environmentId).toBe(remote);
    expect(graph.nodes.find((node) => node.title === "elsewhere")?.missing).toBe(true);
    expect(graph.nodes.find((node) => node.title === "Nested worker")?.status).toBe("running");
  });

  it("deduplicates projected workers, preserves live status, and terminates malformed cycles", () => {
    const child = { ...root, threadId: ThreadId.make("child") };
    const graph = deriveAgentExecutionGraph({
      root,
      threads: [
        { ref: root, parent: child, title: "Root", status: "running" },
        { ref: child, parent: root, title: "Worker", status: "waiting" },
      ],
      projections: [
        {
          owner: root,
          subagents: [
            {
              id: NodeId.make("task"),
              parentNodeId: NodeId.make("run"),
              childThreadId: child.threadId,
              title: "Old title",
              prompt: "Implement",
              status: "completed",
              model: "model",
              result: "Done",
            } as OrchestrationV2Subagent,
            ...["cycle-a", "cycle-b", "self"].map(
              (id, index) =>
                ({
                  id: NodeId.make(id),
                  parentNodeId: NodeId.make(
                    index === 2 ? "self" : index === 0 ? "cycle-b" : "cycle-a",
                  ),
                  childThreadId: null,
                  title: id,
                  prompt: "",
                  status: "running",
                  model: null,
                  result: null,
                }) as OrchestrationV2Subagent,
            ),
          ],
        },
      ],
    });
    expect(graph.nodes.map((node) => [node.title, node.status])).toEqual([
      ["Root", "running"],
      ["Worker", "waiting"],
      ["cycle-a", "running"],
      ["self", "running"],
      ["cycle-b", "running"],
    ]);
    expect(graph.edges).toHaveLength(4);
    expect(graph.nodes[1]?.objective).toBe("Implement");
  });
});
