import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { EnvironmentId, ThreadId, type AgentExecutionRecord } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { deriveAgentExecutionGraph } from "@t3tools/client-runtime/state/agent-execution-graph";

import { render } from "../../../test/render";
import { useRightPanelStore } from "../../rightPanelStore";
import { AgentsPanel } from "./AgentsPanel";

function setup() {
  const environmentId = EnvironmentId.make("agents-panel-test");
  const root = { environmentId, threadId: ThreadId.make("root") };
  const worker = { environmentId, threadId: ThreadId.make("worker") };
  const graph = deriveAgentExecutionGraph({
    root,
    threads: [
      { ref: root, title: "Coordinator", status: "waiting" },
      { ref: worker, parent: root, title: "Worker", status: "completed" },
    ],
    projections: [],
  });
  useRightPanelStore.setState({ byThreadKey: {} });
  useRightPanelStore.getState().open(root, "agents");
  const record: AgentExecutionRecord = {
    threadId: worker.threadId,
    revision: 1,
    objective: "Repair parser",
    checkpoint: null,
    updatedAt: "2026-11-09T00:00:00.000Z",
    updatedBy: "agent",
    tasks: [{ id: "parse", title: "Handle escaped delimiters", status: "done" }],
    verifications: [
      {
        id: "unit",
        title: "Parser tests",
        status: "passed",
        provenance: "server-observed",
        freshness: "current",
        evidence: [{ kind: "test", summary: "12 tests passed" }],
      },
      {
        id: "review",
        title: "Review changes",
        status: "pending",
        provenance: "agent-reported",
        freshness: "unknown",
        evidence: [],
      },
    ],
  };
  return { root, worker, graph, records: new Map([[scopedThreadKey(worker), record]]) };
}

it("inspects a worker without leaving the current thread and retains its view across tabs", async () => {
  const { root, graph, records } = setup();
  await using screen = await render(
    <div style={{ width: 700, height: 700, display: "flex" }}>
      <AgentsPanel graph={graph} threadRef={root} visible executionRecords={records} />
    </div>,
  );
  await userEvent.click(screen.getByRole("treeitem", { name: /Worker/ }));
  await expect.element(screen.getByRole("heading", { name: "Worker", exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("Handle escaped delimiters", { exact: false }))
    .toBeVisible();
  await expect
    .element(screen.getByText("pending · agent-reported · unknown evidence"))
    .toBeVisible();
  await userEvent.click(screen.getByText("Evidence (1)"));
  await expect.element(screen.getByText("test: 12 tests passed")).toBeVisible();
  expect(screen.router?.state.location.pathname).toBe("/");
  await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  await expect.element(screen.getByText("120%")).toBeVisible();
  await screen.unmount();
  await using reopened = await render(
    <div style={{ width: 700, height: 700, display: "flex" }}>
      <AgentsPanel graph={graph} threadRef={root} visible executionRecords={records} />
    </div>,
  );
  await expect.element(reopened.getByText("120%")).toBeVisible();
  await expect
    .element(reopened.getByRole("heading", { name: "Worker", exact: true }))
    .toBeVisible();
});

it("collapses a branch without losing its inspection and fits it when expanded", async () => {
  const { root, graph, records } = setup();
  await using screen = await render(
    <div style={{ width: 700, height: 700, display: "flex" }}>
      <AgentsPanel graph={graph} threadRef={root} visible executionRecords={records} />
    </div>,
  );
  await userEvent.click(screen.getByRole("treeitem", { name: /Worker/ }));
  await userEvent.click(screen.getByRole("button", { name: "Collapse Coordinator" }));
  await expect.element(screen.getByRole("treeitem", { name: /Worker/ })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("heading", { name: "Worker", exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Expand Coordinator" }));
  await userEvent.click(screen.getByRole("button", { name: "Fit tree" }));
  await expect.element(screen.getByRole("treeitem", { name: /Worker/ })).toBeVisible();
});

it("preserves edits after a revision conflict and sends manual confirmation with evidence", async () => {
  const { root, worker, graph, records } = setup();
  const update = vi
    .fn()
    .mockRejectedValueOnce(new Error("The execution record changed. Reload it before editing."));
  await using screen = await render(
    <div style={{ width: 700, height: 1000, display: "flex" }}>
      <AgentsPanel
        graph={graph}
        threadRef={root}
        visible
        executionRecords={records}
        onUpdate={update}
      />
    </div>,
  );
  await userEvent.click(screen.getByRole("treeitem", { name: /Worker/ }));
  await userEvent.click(screen.getByRole("button", { name: "Edit objective and checklists" }));
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Objective" }),
    "Review parser boundaries",
  );
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "Verification status of Review changes" }),
    "passed",
  );
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Evidence for Review changes" }),
    "Checked escaped input against the fixture",
  );
  await userEvent.click(screen.getByRole("button", { name: "Add evidence" }).last());
  await userEvent.click(
    screen.getByRole("checkbox", { name: "I verified this result and its evidence" }).last(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Save and steer agent" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("The execution record changed. Reload it before editing.");
  await expect
    .element(screen.getByRole("textbox", { name: "Objective" }))
    .toHaveValue("Review parser boundaries");
  expect(update).toHaveBeenCalledWith(
    worker,
    expect.objectContaining({
      revision: 1,
      objective: "Review parser boundaries",
      verifications: expect.arrayContaining([
        expect.objectContaining({
          id: "review",
          status: "passed",
          evidence: [{ kind: "manual", summary: "Checked escaped input against the fixture" }],
        }),
      ]),
    }),
    ["review"],
  );
});
