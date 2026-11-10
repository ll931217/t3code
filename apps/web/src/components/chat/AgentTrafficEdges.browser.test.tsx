import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type AgentCommunication } from "@t3tools/contracts";
import { deriveAgentExecutionGraph } from "@t3tools/client-runtime/state/agent-execution-graph";
import { render } from "../../../test/render";
import { AgentTrafficEdges } from "./AgentTrafficEdges";

it("does not replay history and cancels finite delivery motion when the panel hides", async () => {
  const environmentId = EnvironmentId.make("traffic");
  const root = { environmentId, threadId: ThreadId.make("root") };
  const worker = { environmentId, threadId: ThreadId.make("worker") };
  const graph = deriveAgentExecutionGraph({
    root,
    threads: [
      { ref: root, title: "Root", status: "running" },
      { ref: worker, parent: root, title: "Worker", status: "running" },
    ],
    projections: [],
  });
  const positions = new Map(graph.nodes.map((node, index) => [node.key, { x: 0, y: index * 144 }]));
  const sent: AgentCommunication = {
    id: "message",
    source: root,
    target: worker,
    kind: "message",
    status: "sent",
    summary: "Assignment",
    occurredAt: "2026-11-09T00:00:00Z",
  };
  using animate = vi.spyOn(Element.prototype, "animate");
  await using screen = await render(
    <svg>
      <AgentTrafficEdges
        graph={graph}
        positions={positions}
        communications={[sent]}
        liveCommunications={[sent]}
        visible
      />
    </svg>,
  );
  expect(animate).not.toHaveBeenCalled();
  const delivered = { ...sent, status: "delivered" as const };
  await screen.rerender(
    <svg>
      <AgentTrafficEdges
        graph={graph}
        positions={positions}
        communications={[delivered]}
        liveCommunications={[delivered]}
        visible
      />
    </svg>,
  );
  await vi.waitFor(() => expect(animate).toHaveBeenCalledTimes(1));
  const animation = animate.mock.results[0]!.value as Animation;
  expect(animation.effect?.getTiming().iterations).toBe(1);
  await screen.rerender(
    <svg>
      <AgentTrafficEdges
        graph={graph}
        positions={positions}
        communications={[delivered]}
        liveCommunications={[delivered]}
        visible={false}
      />
    </svg>,
  );
  expect(animation.playState).toBe("idle");
});
