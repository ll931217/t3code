import type { ComponentPropsWithRef } from "react";
import { Bot } from "lucide-react";
import { cn } from "../../lib/utils";
import { AgentNodeStatus } from "./AgentNodeStatus";

export function AgentExecutionNode({
  title,
  objective,
  status,
  childCount,
  selected,
  className,
  ...props
}: ComponentPropsWithRef<"button"> & {
  title: string;
  objective: string;
  status: string | null;
  childCount: number;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "flex w-full flex-col gap-1 rounded-lg border p-3 text-left shadow-sm focus-visible:outline-2 focus-visible:outline-ring",
        selected ? "border-primary bg-accent" : "border-border bg-background",
        className,
      )}
    >
      <span className="flex w-full items-center gap-2 text-xs font-medium">
        <Bot className="size-3 shrink-0" />
        <span className="truncate">{title}</span>
      </span>
      <span className="w-full whitespace-pre-wrap wrap-anywhere text-xs text-muted-foreground">
        {objective}
      </span>
      <AgentNodeStatus status={status} childCount={childCount} />
    </button>
  );
}
