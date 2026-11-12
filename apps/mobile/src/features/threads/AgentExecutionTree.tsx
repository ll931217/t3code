import { useRef, useState } from "react";
import { Pressable, ScrollView, View, type ScrollViewInstance } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";
import {
  hideDoneAgents,
  type AgentExecutionGraph,
  type AgentGraphNode,
} from "@t3tools/client-runtime/state/agent-execution-graph";
import type { AgentCommunication, AgentExecutionRecord } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { AgentTrafficPulse } from "./AgentTrafficPulse";

const ThemedSvg = withUniwind(Svg);

export function AgentExecutionTree(props: {
  graph: AgentExecutionGraph;
  records: ReadonlyMap<string, AgentExecutionRecord>;
  liveCommunications: ReadonlyArray<AgentCommunication>;
  visible: boolean;
  selectedKey: string;
  onSelect: (node: AgentGraphNode) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [initialEvents] = useState(
    () =>
      new Set(
        props.liveCommunications.map((entry) =>
          JSON.stringify([entry.source.environmentId, entry.id, entry.status]),
        ),
      ),
  );
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [showFinished, setShowFinished] = useState(false);
  const graph = showFinished ? props.graph : hideDoneAgents(props.graph);
  const collapsedKeys = new Set(collapsed);
  const parents = new Set(graph.edges.map((edge) => edge.source));
  const [width, setWidth] = useState(360);
  const horizontal = useRef<ScrollViewInstance>(null);
  const vertical = useRef<ScrollViewInstance>(null);
  const hidden = new Set<string>();
  for (const node of graph.nodes)
    if (node.parentKey && (hidden.has(node.parentKey) || collapsedKeys.has(node.parentKey)))
      hidden.add(node.key);
  const nodes = graph.nodes.filter((node) => !hidden.has(node.key));
  const levels = new Map<number, AgentGraphNode[]>();
  for (const node of nodes) {
    const level = levels.get(node.depth) ?? [];
    level.push(node);
    levels.set(node.depth, level);
  }
  const graphWidth = Math.max(
    width / zoom,
    Math.max(1, ...[...levels.values()].map((level) => level.length)) * 230,
  );
  const graphHeight = (Math.max(0, ...levels.keys()) + 1) * 132;
  const positions = new Map<string, { x: number; y: number }>();
  for (const [depth, level] of levels)
    level.forEach((node, index) =>
      positions.set(node.key, {
        x: graphWidth / 2 + (index - (level.length - 1) / 2) * 230 - 100,
        y: depth * 132 + 12,
      }),
    );
  const focus = () => {
    const position = positions.get(props.selectedKey);
    if (!position) return;
    horizontal.current?.scrollTo({
      x: Math.max(0, (position.x + 100) * zoom - width / 2),
      animated: false,
    });
    vertical.current?.scrollTo({ y: Math.max(0, position.y * zoom - 80), animated: false });
  };
  return (
    <View className="gap-2" onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <View className="flex-row flex-wrap gap-2">
        <Button
          size="compact"
          label="−"
          accessibilityLabel="Zoom out"
          onPress={() => setZoom(Math.max(0.25, zoom / 1.2))}
        />
        <Text className="self-center text-xs text-foreground">{Math.round(zoom * 100)}%</Text>
        <Button
          size="compact"
          label="+"
          accessibilityLabel="Zoom in"
          onPress={() => setZoom(Math.min(2, zoom * 1.2))}
        />
        <Button
          size="compact"
          label="Fit"
          onPress={() => {
            setZoom(Math.max(0.25, Math.min(1, width / graphWidth, 300 / graphHeight)));
            horizontal.current?.scrollTo({ x: 0, animated: false });
            vertical.current?.scrollTo({ y: 0, animated: false });
          }}
        />
        <Button size="compact" label="Selected" onPress={focus} />
        <Button
          size="compact"
          label={showFinished ? "Hide finished" : "Show finished"}
          onPress={() => setShowFinished(!showFinished)}
        />
      </View>
      <ScrollView ref={vertical} nestedScrollEnabled style={{ height: 320 }}>
        <ScrollView ref={horizontal} horizontal nestedScrollEnabled>
          <View style={{ width: graphWidth * zoom, height: graphHeight * zoom }}>
            {props.liveCommunications
              .filter(
                (entry) =>
                  !initialEvents.has(
                    JSON.stringify([entry.source.environmentId, entry.id, entry.status]),
                  ),
              )
              .slice(-16)
              .map((entry) => {
                const source = graph.nodes.find(
                  (node) => node.ref && scopedThreadKey(node.ref) === scopedThreadKey(entry.source),
                );
                const target = graph.nodes.find(
                  (node) => node.ref && scopedThreadKey(node.ref) === scopedThreadKey(entry.target),
                );
                const from = source ? positions.get(source.key) : null;
                const to = target ? positions.get(target.key) : null;
                return from && to ? (
                  <AgentTrafficPulse
                    key={JSON.stringify([entry.source.environmentId, entry.id, entry.status])}
                    visible={props.visible}
                    from={{ x: (from.x + 100) * zoom, y: (from.y + 44) * zoom }}
                    to={{ x: (to.x + 100) * zoom, y: (to.y + 44) * zoom }}
                  />
                ) : null;
              })}
            <ThemedSvg
              width={graphWidth * zoom}
              height={graphHeight * zoom}
              viewBox={`0 0 ${graphWidth} ${graphHeight}`}
              colorClassName="accent-foreground-muted"
              style={{ position: "absolute" }}
              accessible={false}
            >
              {graph.edges.map((edge) => {
                const from = positions.get(edge.source);
                const to = positions.get(edge.target);
                return from && to ? (
                  <Path
                    key={edge.target}
                    d={`M${from.x + 100},${from.y + 88} V${from.y + 110} H${to.x + 100} V${to.y}`}
                    stroke="currentColor"
                    fill="none"
                  />
                ) : null;
              })}
            </ThemedSvg>
            {nodes.map((node) => {
              const point = positions.get(node.key)!;
              const record = node.ref ? props.records.get(scopedThreadKey(node.ref)) : undefined;
              const children = parents.has(node.key);
              return (
                <View
                  key={node.key}
                  style={{
                    position: "absolute",
                    left: point.x * zoom,
                    top: point.y * zoom,
                    width: 200 * zoom,
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: node.key === props.selectedKey }}
                    onPress={() => props.onSelect(node)}
                    className={`rounded-lg border p-2 ${node.key === props.selectedKey ? "border-primary bg-secondary" : "border-border bg-sheet"}`}
                    style={{ height: 88 * zoom }}
                  >
                    <Text
                      numberOfLines={1}
                      className="font-t3-bold text-foreground"
                      style={{ fontSize: 12 * zoom }}
                    >
                      {node.title}
                    </Text>
                    <Text
                      numberOfLines={2}
                      className="text-foreground-secondary"
                      style={{ fontSize: 10 * zoom }}
                    >
                      {record?.objective || node.objective || "Awaiting assignment"}
                    </Text>
                    <Text
                      numberOfLines={1}
                      className="text-foreground-muted"
                      style={{ fontSize: 10 * zoom }}
                    >
                      {node.status ?? "Unavailable"}
                    </Text>
                  </Pressable>
                  {children ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${collapsedKeys.has(node.key) ? "Expand" : "Collapse"} ${node.title}`}
                      onPress={() =>
                        setCollapsed(
                          collapsedKeys.has(node.key)
                            ? collapsed.filter((key) => key !== node.key)
                            : [...collapsed, node.key],
                        )
                      }
                    >
                      <Text className="text-center text-primary-text">
                        {collapsedKeys.has(node.key) ? "+" : "−"}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}
