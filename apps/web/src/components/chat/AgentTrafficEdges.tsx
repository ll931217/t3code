import { useEffect, useEffectEvent, useRef } from "react";
import type { AgentCommunication } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AgentExecutionGraph } from "@t3tools/client-runtime/state/agent-execution-graph";

export function AgentTrafficEdges(props: {
  graph: AgentExecutionGraph;
  positions: ReadonlyMap<string, { x: number; y: number; height?: number }>;
  communications: ReadonlyArray<AgentCommunication>;
  liveCommunications: ReadonlyArray<AgentCommunication>;
  visible: boolean;
}) {
  const layer = useRef<SVGGElement>(null);
  const liveKey = JSON.stringify(
    props.liveCommunications.map((entry) => [entry.id, entry.source.environmentId, entry.status]),
  );
  const seen = useRef(
    new Set(
      props.liveCommunications.map((entry) =>
        JSON.stringify([entry.source.environmentId, entry.id, entry.status]),
      ),
    ),
  );
  const positions = new Map(
    props.graph.nodes.flatMap((node) => {
      const point = props.positions.get(node.key);
      return node.ref && point
        ? [
            [
              scopedThreadKey(node.ref),
              { x: point.x + 104, y: point.y + (point.height ?? 88) / 2 },
            ] as const,
          ]
        : [];
    }),
  );
  const readEvents = useEffectEvent(() => ({ events: props.liveCommunications, positions }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- finite browser animations reflect new server delivery events and stop when hidden or reduced motion is requested
  useEffect(() => {
    if (liveKey === "[]") {
      seen.current = new Set();
      return;
    }
    const { events, positions: points } = readEvents();
    const next = new Set(
      events.map((entry) => JSON.stringify([entry.source.environmentId, entry.id, entry.status])),
    );
    const fresh = events.filter(
      (entry) =>
        !seen.current.has(JSON.stringify([entry.source.environmentId, entry.id, entry.status])),
    );
    seen.current = next;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!props.visible || document.hidden || media.matches || !layer.current) return;
    const active: Array<{ animation: Animation; element: SVGCircleElement }> = [];
    for (const entry of fresh.slice(-16)) {
      const from = points.get(scopedThreadKey(entry.source));
      const to = points.get(scopedThreadKey(entry.target));
      if (!from || !to) continue;
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("r", "4");
      circle.setAttribute("fill", "var(--color-primary)");
      layer.current.append(circle);
      const animation = circle.animate(
        [
          { transform: `translate(${from.x}px, ${from.y}px)`, opacity: 0 },
          { opacity: 1, offset: 0.15 },
          { transform: `translate(${to.x}px, ${to.y}px)`, opacity: 0 },
        ],
        { duration: 850, easing: "ease-out" },
      );
      animation.onfinish = () => circle.remove();
      active.push({ animation, element: circle });
    }
    const cancel = () =>
      active.forEach(({ animation, element }) => {
        animation.cancel();
        element.remove();
      });
    const onVisibility = () => {
      if (document.hidden) cancel();
    };
    const onMotion = () => {
      if (media.matches) cancel();
    };
    document.addEventListener("visibilitychange", onVisibility);
    media.addEventListener("change", onMotion);
    return () => {
      cancel();
      document.removeEventListener("visibilitychange", onVisibility);
      media.removeEventListener("change", onMotion);
    };
  }, [liveKey, props.visible]);
  const links = new Map(
    props.communications.map((entry) => [JSON.stringify([entry.source, entry.target]), entry]),
  );
  return (
    <g aria-label="Agent communication links">
      {[...links].map(([key, entry]) => {
        const from = positions.get(scopedThreadKey(entry.source));
        const to = positions.get(scopedThreadKey(entry.target));
        return from && to ? (
          <path
            key={key}
            d={`M${from.x},${from.y} L${to.x},${to.y}`}
            fill="none"
            stroke="var(--color-primary)"
            opacity={0.35}
            strokeDasharray="4 5"
          />
        ) : null;
      })}
      <g ref={layer} />
    </g>
  );
}
