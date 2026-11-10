import { Badge } from "../ui/badge";

function statusVariant(status: string | null) {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "error":
      return "error";
    case "waiting":
    case "interrupted":
    case "rolled_back":
      return "warning";
    case "pending":
    case "preparing":
    case "queued":
    case "starting":
    case "running":
      return "info";
    default:
      return "secondary";
  }
}

export function AgentNodeStatus(props: { status: string | null; childCount: number }) {
  const label = props.status?.replace(/[_-]+/g, " ") ?? "Unavailable";
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge size="sm" variant={statusVariant(props.status)}>
        {label.charAt(0).toUpperCase() + label.slice(1)}
      </Badge>
      {props.childCount > 0 ? (
        <span className="text-2xs text-muted-foreground">
          {props.childCount} {props.childCount === 1 ? "child" : "children"}
        </span>
      ) : null}
    </span>
  );
}
