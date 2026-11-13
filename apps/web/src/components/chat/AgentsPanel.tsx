import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, LocateFixed, Minus, Plus } from "lucide-react";
import type {
  AgentCommunication,
  AgentExecutionRecord,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  hideDoneAgents,
  type AgentExecutionGraph,
  type AgentGraphNode,
} from "@t3tools/client-runtime/state/agent-execution-graph";
import {
  DEFAULT_AGENT_GRAPH_VIEW,
  useRightPanelStore,
  type AgentGraphView,
} from "../../rightPanelStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { observeResize } from "../../lib/observeResize";
import { randomUUID } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { AgentTrafficEdges } from "./AgentTrafficEdges";
import { AgentVerificationEditor } from "./AgentVerificationEditor";
import { AgentExecutionNode } from "./AgentExecutionNode";

const NODE_WIDTH = 208;
const NODE_HEIGHT = 88;
const LONG_OBJECTIVE_CHARS = 600;

function AgentObjective(props: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const text = props.text.trim();
  const long = text.length > LONG_OBJECTIVE_CHARS || text.split("\n").length > 12;
  return (
    <div>
      <h3 className="mb-1 font-medium">Objective</h3>
      {text ? (
        <>
          <div className={long && !expanded ? "max-h-64 overflow-hidden mask-b-from-70%" : ""}>
            <ChatMarkdown text={text} cwd={undefined} />
          </div>
          {long ? (
            <Button
              size="xs"
              variant="ghost"
              className="mt-1"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Show less" : "Show more"}
            </Button>
          ) : null}
        </>
      ) : (
        <p className="text-muted-foreground">No objective recorded yet.</p>
      )}
    </div>
  );
}

const COMMUNICATION_LABELS: Record<AgentCommunication["kind"], string> = {
  dispatch: "Task",
  message: "Message",
  result: "Result",
};

function AgentCommunicationList(props: {
  entries: ReadonlyArray<AgentCommunication>;
  titles: ReadonlyMap<string, string>;
}) {
  const name = (ref: ScopedThreadRef) => props.titles.get(scopedThreadKey(ref)) ?? "Unknown agent";
  return (
    <section className="space-y-2 border-t border-border p-4 text-xs">
      <h3 className="font-medium">Communication</h3>
      <ol className="space-y-3">
        {props.entries.map((entry) => (
          <li key={entry.id} className="space-y-0.5">
            <p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
              <span className="font-medium text-foreground">
                {COMMUNICATION_LABELS[entry.kind]}
              </span>
              <span>
                {name(entry.source)} → {name(entry.target)}
              </span>
              <span>· {entry.status}</span>
              <time dateTime={entry.occurredAt}>· {formatRelativeTimeLabel(entry.occurredAt)}</time>
            </p>
            <p className="line-clamp-3 wrap-anywhere">{entry.summary}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function AgentDetails(props: {
  node: AgentGraphNode;
  record: AgentExecutionRecord | undefined;
  onOpen: () => void;
  onUpdate?: ((record: AgentExecutionRecord, confirmed: string[]) => Promise<void>) | undefined;
  onStop?: (() => Promise<void>) | undefined;
  onCancel?: (() => Promise<void>) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.record);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action could not be completed.");
    }
    setBusy(false);
  };
  const record = props.record;
  return (
    <section aria-label="Selected agent details" className="space-y-4 p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{props.node.title}</h2>
          <p className="text-xs text-muted-foreground">
            {props.node.status ?? "Status unavailable"}
            {props.node.model ? ` · ${props.node.model}` : ""}
          </p>
        </div>
        {props.node.ref ? (
          <Button variant="outline" size="xs" onClick={props.onOpen}>
            Open thread
          </Button>
        ) : null}
      </div>
      {props.node.projectName ? (
        <p className="text-xs text-muted-foreground">{props.node.projectName}</p>
      ) : null}
      {props.node.missing ? (
        <p className="text-xs text-muted-foreground">
          This agent's environment or thread is unavailable. Showing the last recorded delegation.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {editing && draft ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (props.onUpdate) void run(() => props.onUpdate!(draft, confirmed));
          }}
        >
          <label className="block space-y-1">
            Objective
            <Textarea
              value={draft.objective}
              onChange={(event) => setDraft({ ...draft, objective: event.target.value })}
            />
          </label>
          <fieldset className="space-y-2">
            <legend className="font-medium">Tasks</legend>
            {draft.tasks.map((task) => (
              <div key={task.id} className="flex items-center gap-2">
                <Input
                  aria-label="Task title"
                  value={task.title}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      tasks: draft.tasks.map((entry) =>
                        entry.id === task.id ? { ...entry, title: event.target.value } : entry,
                      ),
                    })
                  }
                />
                <select
                  aria-label={`Status of ${task.title}`}
                  value={task.status}
                  className="rounded border border-input bg-background p-1 text-xs"
                  onChange={(event) => {
                    const status = event.target.value as typeof task.status;
                    setDraft({
                      ...draft,
                      tasks: draft.tasks.map((entry) =>
                        entry.id === task.id ? { ...entry, status } : entry,
                      ),
                    });
                  }}
                >
                  {["pending", "in-progress", "blocked", "done"].map((status) => (
                    <option key={status}>{status}</option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${task.title}`}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      tasks: draft.tasks.filter((entry) => entry.id !== task.id),
                    })
                  }
                >
                  ×
                </Button>
              </div>
            ))}
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                setDraft({
                  ...draft,
                  tasks: [
                    ...draft.tasks,
                    { id: randomUUID(), title: "New task", status: "pending" },
                  ],
                })
              }
            >
              Add task
            </Button>
          </fieldset>
          <AgentVerificationEditor
            checks={draft.verifications}
            confirmed={confirmed}
            onConfirm={setConfirmed}
            onChange={(verifications) => setDraft({ ...draft, verifications })}
          />
          <div className="flex gap-2">
            <Button size="xs" type="submit" disabled={busy}>
              Save and steer agent
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <AgentObjective text={record?.objective || props.node.objective || ""} />
          {props.onUpdate && props.node.ref ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setDraft(
                  record ?? {
                    threadId: props.node.ref!.threadId,
                    objective: props.node.objective ?? "",
                    revision: 0,
                    tasks: [],
                    verifications: [],
                    checkpoint: null,
                    updatedAt: new Date().toISOString(),
                    updatedBy: "user",
                  },
                );
                setConfirmed([]);
                setEditing(true);
              }}
            >
              Edit objective and checklists
            </Button>
          ) : null}
          <div>
            <h3 className="mb-2 font-medium">Tasks</h3>
            {record?.tasks.length ? (
              <ul className="space-y-2">
                {record.tasks.map((task) => (
                  <li key={task.id} className="flex gap-2">
                    <span aria-label={task.status}>{task.status === "done" ? "☑" : "☐"}</span>
                    <span>
                      {task.title}
                      <span className="ml-2 text-xs text-muted-foreground">{task.status}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No tasks recorded yet.</p>
            )}
          </div>
          {record?.verifications.length ? (
            <div>
              <h3 className="mb-2 font-medium">Verification</h3>
              <ul className="space-y-3">
                {record.verifications.map((check) => (
                  <li key={check.id}>
                    <div className="flex gap-2">
                      <span aria-label={check.status}>{check.status === "passed" ? "☑" : "☐"}</span>
                      <span>{check.title}</span>
                    </div>
                    <p className="ml-5 text-xs text-muted-foreground">
                      {check.status} · {check.provenance} ·{" "}
                      {check.freshness === "current"
                        ? "current evidence"
                        : `${check.freshness} evidence`}
                    </p>
                    {check.evidence.length ? (
                      <details className="ml-5 mt-1 text-xs">
                        <summary className="cursor-pointer">
                          Evidence ({check.evidence.length})
                        </summary>
                        {[
                          ...new Map(
                            check.evidence.map((evidence) => [JSON.stringify(evidence), evidence]),
                          ).entries(),
                        ].map(([key, evidence]) => (
                          <p key={key} className="mt-1 whitespace-pre-wrap wrap-anywhere">
                            {evidence.kind}: {evidence.summary}
                            {evidence.reference ? ` (${evidence.reference})` : ""}
                          </p>
                        ))}
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      {props.node.progress ? (
        <div>
          <h3 className="font-medium">Latest reported activity</h3>
          <p className="whitespace-pre-wrap wrap-anywhere text-muted-foreground">
            {props.node.progress}
          </p>
        </div>
      ) : null}
      {props.node.result ? (
        <div>
          <h3 className="font-medium">Result</h3>
          <p className="whitespace-pre-wrap wrap-anywhere text-muted-foreground">
            {props.node.result}
          </p>
        </div>
      ) : null}
      {record ? (
        <p className="text-xs text-muted-foreground">
          Revision {record.revision} · updated by {record.updatedBy}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {props.onStop ? (
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => void run(props.onStop!)}
          >
            Stop this agent
          </Button>
        ) : null}
        {props.onCancel ? (
          <Button
            variant="destructive-outline"
            size="xs"
            disabled={busy}
            onClick={() => void run(props.onCancel!)}
          >
            Cancel subtree
          </Button>
        ) : null}
      </div>
    </section>
  );
}

export function AgentsPanel(props: {
  threadRef: ScopedThreadRef;
  visible: boolean;
  graph: AgentExecutionGraph;
  executionRecords?: ReadonlyMap<string, AgentExecutionRecord>;
  writableEnvironments?: ReadonlySet<EnvironmentId>;
  stoppableEnvironments?: ReadonlySet<EnvironmentId>;
  liveCommunications?: ReadonlyArray<AgentCommunication>;
  communications?: ReadonlyArray<AgentCommunication>;
  renderMetadata?: (ref: ScopedThreadRef) => ReactNode;
  onUpdate?: (
    ref: ScopedThreadRef,
    record: AgentExecutionRecord,
    confirmVerificationIds?: string[],
  ) => Promise<void>;
  onStopNode?: (ref: ScopedThreadRef) => Promise<void>;
  onCancelSubtree?: (ref: ScopedThreadRef) => Promise<void>;
}) {
  const navigate = useNavigate();
  const surface = useRightPanelStore((state) =>
    state.byThreadKey[scopedThreadKey(props.threadRef)]?.surfaces.find(
      (entry) => entry.kind === "agents",
    ),
  );
  const storedView =
    surface?.kind === "agents"
      ? (surface.view ?? DEFAULT_AGENT_GRAPH_VIEW)
      : DEFAULT_AGENT_GRAPH_VIEW;
  const [gestureView, setGestureView] = useState<AgentGraphView | null>(null);
  const view = gestureView ?? storedView;
  const saveView = (patch: Partial<AgentGraphView>) =>
    useRightPanelStore.getState().setAgentsView(props.threadRef, { ...view, ...patch });
  const graph = view.showFinished ? props.graph : hideDoneAgents(props.graph);
  const selected = graph.nodes.find((node) => node.key === view.selectedKey) ?? graph.nodes[0]!;
  const hidden = new Set<string>();
  const collapsed = new Set(view.collapsedKeys);
  for (const node of graph.nodes)
    if (node.parentKey && (hidden.has(node.parentKey) || collapsed.has(node.parentKey)))
      hidden.add(node.key);
  const shown = graph.nodes.filter((node) => !hidden.has(node.key));
  const levels = new Map<number, AgentGraphNode[]>();
  for (const node of shown) {
    const level = levels.get(node.depth) ?? [];
    level.push(node);
    levels.set(node.depth, level);
  }
  const childCounts = new Map<string, number>();
  for (const edge of graph.edges)
    childCounts.set(edge.source, (childCounts.get(edge.source) ?? 0) + 1);
  const [nodeHeights, setNodeHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const positions = new Map<string, { x: number; y: number; height: number }>();
  let graphHeight = 0;
  for (const [, nodes] of [...levels].sort(([a], [b]) => a - b)) {
    nodes.forEach((node, index) =>
      positions.set(node.key, {
        x: (index - (nodes.length - 1) / 2) * 240 - NODE_WIDTH / 2,
        y: graphHeight,
        height: nodeHeights.get(node.key) ?? NODE_HEIGHT,
      }),
    );
    graphHeight += Math.max(...nodes.map((node) => nodeHeights.get(node.key) ?? NODE_HEIGHT)) + 56;
  }
  graphHeight = Math.max(1, graphHeight - 56);
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; view: AgentGraphView; mode: "pan" | "split" } | null>(
    null,
  );
  const [canvasSize, setCanvasSize] = useState({ width: 400, height: 300 });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measure the external canvas so fit and follow use its actual viewport
  useEffect(
    () =>
      canvas.current
        ? observeResize(canvas.current, (entries) => {
            const bounds = entries[0]?.contentRect;
            if (bounds) setCanvasSize({ width: bounds.width, height: bounds.height });
          })
        : undefined,
    [],
  );
  const shownKey = JSON.stringify(shown.map((node) => node.key));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observe rendered node heights so wrapped objectives cannot overlap later rows
  useEffect(() => {
    if (!canvas.current || !props.visible) return;
    const keys = new Set<string>(JSON.parse(shownKey));
    const elements = Array.from(
      canvas.current.querySelectorAll<HTMLButtonElement>("[data-agent-node-key]"),
    );
    return observeResize(elements, (entries) => {
      setNodeHeights((previous) => {
        const next = new Map([...previous].filter(([key]) => keys.has(key)));
        let changed = next.size !== previous.size;
        for (const entry of entries) {
          const element = entry.target as HTMLButtonElement;
          const key = element.dataset.agentNodeKey;
          const height = entry.borderBoxSize[0]?.blockSize ?? element.offsetHeight;
          if (key && height > 0 && next.get(key) !== height) {
            next.set(key, height);
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    });
  }, [shownKey, props.visible]);
  const selectedPosition = positions.get(selected.key);
  const x =
    view.follow && selectedPosition ? -(selectedPosition.x + NODE_WIDTH / 2) * view.zoom : view.x;
  const y =
    view.follow && selectedPosition
      ? canvasSize.height / 2 - (selectedPosition.y + selectedPosition.height / 2) * view.zoom
      : view.y;
  const zoom = (next: number) => saveView({ zoom: Math.max(0.15, Math.min(2, next)) });
  const fit = () => {
    const width = Math.max(1, ...[...levels.values()].map((nodes) => nodes.length)) * 240;
    saveView({
      x: 0,
      y: 16,
      zoom: Math.max(
        0.15,
        Math.min(1, (canvasSize.width - 32) / width, (canvasSize.height - 32) / graphHeight),
      ),
      follow: false,
    });
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>, mode: "pan" | "split") => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button")))
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, view: { ...view, x, y }, mode };
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    if (start.mode === "pan")
      setGestureView({
        ...start.view,
        x: start.view.x + event.clientX - start.x,
        y: start.view.y + event.clientY - start.y,
        follow: false,
      });
    else
      setGestureView({
        ...start.view,
        split: Math.max(
          0.2,
          Math.min(
            0.8,
            start.view.split +
              (event.clientY - start.y) / Math.max(1, container.current?.clientHeight ?? 1),
          ),
        ),
      });
  };
  const finishGesture = () => {
    if (gestureView) useRightPanelStore.getState().setAgentsView(props.threadRef, gestureView);
    setGestureView(null);
    drag.current = null;
  };
  const record = selected.ref
    ? props.executionRecords?.get(scopedThreadKey(selected.ref))
    : undefined;
  const selectedKey = selected.ref ? scopedThreadKey(selected.ref) : null;
  const selectedCommunications = (props.communications ?? []).filter(
    (entry) =>
      scopedThreadKey(entry.source) === selectedKey ||
      scopedThreadKey(entry.target) === selectedKey,
  );
  const titles = new Map(
    props.graph.nodes.flatMap((node) =>
      node.ref ? [[scopedThreadKey(node.ref), node.title] as const] : [],
    ),
  );
  return (
    <div
      ref={container}
      hidden={!props.visible}
      style={props.visible ? undefined : { display: "none" }}
      className="flex min-h-0 flex-1 flex-col"
      aria-label="Agents workspace"
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-border p-2">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom out"
          onClick={() => zoom(view.zoom / 1.2)}
        >
          <Minus />
        </Button>
        <span className="min-w-10 text-center text-xs tabular-nums">
          {Math.round(view.zoom * 100)}%
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom in"
          onClick={() => zoom(view.zoom * 1.2)}
        >
          <Plus />
        </Button>
        <Button size="xs" variant="ghost" onClick={fit}>
          Fit tree
        </Button>
        <Button
          size="xs"
          variant={view.follow ? "secondary" : "ghost"}
          aria-pressed={view.follow}
          onClick={() => saveView({ follow: !view.follow })}
        >
          <LocateFixed />
          Follow selected
        </Button>
        <Button
          size="xs"
          variant={view.showFinished ? "secondary" : "ghost"}
          aria-pressed={view.showFinished === true}
          onClick={() => saveView({ showFinished: !view.showFinished })}
        >
          Show finished
        </Button>
      </div>
      <div
        ref={canvas}
        role="tree"
        aria-label="Agent execution tree"
        className="relative min-h-24 shrink-0 touch-none overflow-hidden bg-muted/20"
        style={{ height: `${view.split * 100}%` }}
        onPointerDown={(event) => pointerDown(event, "pan")}
        onPointerMove={pointerMove}
        onPointerUp={finishGesture}
        onPointerCancel={finishGesture}
        onWheel={(event) => {
          if (event.ctrlKey || event.metaKey) zoom(view.zoom * Math.exp(-event.deltaY * 0.002));
          else saveView({ x: x - event.deltaX, y: y - event.deltaY, follow: false });
        }}
      >
        <div
          className="absolute left-1/2 top-0 origin-top-left"
          style={{ transform: `translate(${x}px, ${y}px) scale(${view.zoom})` }}
        >
          <svg aria-hidden className="pointer-events-none absolute overflow-visible">
            <AgentTrafficEdges
              graph={graph}
              positions={positions}
              communications={props.communications ?? []}
              liveCommunications={props.liveCommunications ?? []}
              visible={props.visible}
            />
            {graph.edges.map((edge) => {
              const from = positions.get(edge.source);
              const to = positions.get(edge.target);
              return from && to ? (
                <path
                  key={edge.target}
                  d={`M${from.x + NODE_WIDTH / 2},${from.y + from.height} V${to.y - 28} H${to.x + NODE_WIDTH / 2} V${to.y}`}
                  fill="none"
                  stroke="var(--color-border)"
                  strokeWidth={1.5}
                />
              ) : null;
            })}
          </svg>
          {shown.map((node) => {
            const position = positions.get(node.key)!;
            const children = childCounts.get(node.key) ?? 0;
            return (
              <div
                key={node.key}
                className="absolute"
                style={{ left: position.x, top: position.y, width: NODE_WIDTH }}
              >
                <AgentExecutionNode
                  title={node.title}
                  objective={
                    (node.ref
                      ? props.executionRecords?.get(scopedThreadKey(node.ref))?.objective
                      : null) ||
                    node.objective ||
                    ""
                  }
                  status={node.status}
                  childCount={children}
                  selected={selected.key === node.key}
                  data-agent-node-key={node.key}
                  role="treeitem"
                  aria-selected={selected.key === node.key}
                  aria-level={node.depth + 1}
                  aria-expanded={children ? !collapsed.has(node.key) : undefined}
                  tabIndex={
                    selected.key === node.key ||
                    (hidden.has(selected.key) && node.key === graph.rootKey)
                      ? 0
                      : -1
                  }
                  onKeyDown={(event) => {
                    const index = shown.findIndex((entry) => entry.key === node.key);
                    let target: AgentGraphNode | undefined;
                    if (event.key === "ArrowDown") target = shown[index + 1];
                    else if (event.key === "ArrowUp") target = shown[index - 1];
                    else if (event.key === "Home") target = shown[0];
                    else if (event.key === "End") target = shown.at(-1);
                    else if (event.key === "ArrowRight" && children) {
                      if (collapsed.has(node.key))
                        saveView({
                          collapsedKeys: view.collapsedKeys.filter((key) => key !== node.key),
                        });
                      else target = shown.find((entry) => entry.parentKey === node.key);
                    } else if (event.key === "ArrowLeft") {
                      if (children && !collapsed.has(node.key))
                        saveView({ collapsedKeys: [...view.collapsedKeys, node.key] });
                      else target = shown.find((entry) => entry.key === node.parentKey);
                    } else return;
                    event.preventDefault();
                    if (target) {
                      saveView({ selectedKey: target.key });
                      const tree = event.currentTarget.closest('[role="tree"]');
                      const items = tree?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]');
                      items?.item(shown.indexOf(target)).focus();
                    }
                  }}
                  onClick={() => saveView({ selectedKey: node.key })}
                />
                {children ? (
                  <div className="absolute -bottom-3 left-1/2 -translate-x-1/2">
                    <Button
                      size="icon-micro"
                      variant="outline"
                      aria-label={`${collapsed.has(node.key) ? "Expand" : "Collapse"} ${node.title}`}
                      onClick={() =>
                        saveView({
                          collapsedKeys: collapsed.has(node.key)
                            ? view.collapsedKeys.filter((key) => key !== node.key)
                            : [...view.collapsedKeys, node.key],
                        })
                      }
                    >
                      {collapsed.has(node.key) ? <ChevronRight /> : <ChevronDown />}
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <div
        role="separator"
        aria-label="Resize graph and details"
        aria-orientation="horizontal"
        aria-valuenow={Math.round(view.split * 100)}
        aria-valuemin={20}
        aria-valuemax={80}
        tabIndex={0}
        className="h-2 shrink-0 cursor-row-resize touch-none border-y border-border bg-muted/30 focus-visible:bg-accent"
        onPointerDown={(event) => pointerDown(event, "split")}
        onPointerMove={pointerMove}
        onPointerUp={finishGesture}
        onPointerCancel={finishGesture}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            saveView({
              split: Math.max(
                0.2,
                Math.min(0.8, view.split + (event.key === "ArrowDown" ? 0.05 : -0.05)),
              ),
            });
          }
        }}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {selected.ref ? props.renderMetadata?.(selected.ref) : null}
        <AgentDetails
          key={selected.key}
          node={selected}
          record={record}
          onOpen={() => {
            if (selected.ref)
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(selected.ref),
              });
          }}
          onUpdate={
            selected.ref &&
            props.onUpdate &&
            (!props.writableEnvironments ||
              props.writableEnvironments.has(selected.ref.environmentId))
              ? (next, confirmed) => props.onUpdate!(selected.ref!, next, confirmed)
              : undefined
          }
          onStop={
            selected.ref &&
            props.onStopNode &&
            (!props.stoppableEnvironments ||
              props.stoppableEnvironments.has(selected.ref.environmentId))
              ? () => props.onStopNode!(selected.ref!)
              : undefined
          }
          onCancel={
            selected.ref &&
            props.onCancelSubtree &&
            (!props.stoppableEnvironments ||
              props.stoppableEnvironments.has(selected.ref.environmentId))
              ? () => props.onCancelSubtree!(selected.ref!)
              : undefined
          }
        />
        {selectedCommunications.length ? (
          <AgentCommunicationList entries={selectedCommunications} titles={titles} />
        ) : null}
      </div>
    </div>
  );
}
