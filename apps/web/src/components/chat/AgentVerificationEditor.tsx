import { useState } from "react";
import type { AgentVerification } from "@t3tools/contracts";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

function VerificationEditor(props: {
  check: AgentVerification;
  confirmed: boolean;
  onChange: (check: AgentVerification) => void;
  onConfirm: (confirmed: boolean) => void;
  onRemove: () => void;
}) {
  const [evidence, setEvidence] = useState("");
  return (
    <div className="space-y-2 rounded border border-border p-2">
      <Input
        aria-label="Verification title"
        value={props.check.title}
        required
        maxLength={500}
        onChange={(event) => props.onChange({ ...props.check, title: event.target.value })}
      />
      <div className="flex items-center gap-2">
        <select
          aria-label={`Verification status of ${props.check.title}`}
          className="rounded border border-input bg-background p-1 text-xs"
          value={props.check.status}
          onChange={(event) =>
            props.onChange({
              ...props.check,
              status: event.target.value as AgentVerification["status"],
            })
          }
        >
          {["pending", "running", "passed", "failed", "skipped"].map((status) => (
            <option key={status}>{status}</option>
          ))}
        </select>
        <Button size="xs" variant="ghost" onClick={props.onRemove}>
          Remove verification
        </Button>
      </div>
      {props.check.evidence.map((item) => (
        <p key={JSON.stringify(item)} className="text-xs text-muted-foreground">
          {item.kind}: {item.summary}
        </p>
      ))}
      <div className="flex gap-2">
        <Input
          aria-label={`Evidence for ${props.check.title}`}
          placeholder="What did you verify?"
          value={evidence}
          maxLength={4000}
          onChange={(event) => setEvidence(event.target.value)}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={!evidence.trim() || props.check.evidence.length >= 32}
          onClick={() => {
            props.onChange({
              ...props.check,
              evidence: [...props.check.evidence, { kind: "manual", summary: evidence.trim() }],
            });
            setEvidence("");
          }}
        >
          Add evidence
        </Button>
      </div>
      {props.check.status === "passed" ? (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={props.confirmed}
            onChange={(event) => props.onConfirm(event.target.checked)}
          />
          I verified this result and its evidence
        </label>
      ) : null}
    </div>
  );
}

export function AgentVerificationEditor(props: {
  checks: ReadonlyArray<AgentVerification>;
  confirmed: ReadonlyArray<string>;
  onChange: (checks: ReadonlyArray<AgentVerification>) => void;
  onConfirm: (ids: string[]) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="font-medium">Verification and evidence</legend>
      {props.checks.map((check) => (
        <VerificationEditor
          key={check.id}
          check={check}
          confirmed={props.confirmed.includes(check.id)}
          onChange={(next) =>
            props.onChange(props.checks.map((entry) => (entry.id === check.id ? next : entry)))
          }
          onConfirm={(confirmed) =>
            props.onConfirm(
              confirmed
                ? [...props.confirmed, check.id]
                : props.confirmed.filter((id) => id !== check.id),
            )
          }
          onRemove={() => props.onChange(props.checks.filter((entry) => entry.id !== check.id))}
        />
      ))}
      <Button
        size="xs"
        variant="outline"
        disabled={props.checks.length >= 200}
        onClick={() =>
          props.onChange([
            ...props.checks,
            {
              id: randomUUID(),
              title: "New verification",
              status: "pending",
              evidence: [],
              provenance: "user-confirmed",
              freshness: "unknown",
            },
          ])
        }
      >
        Add verification
      </Button>
    </fieldset>
  );
}
