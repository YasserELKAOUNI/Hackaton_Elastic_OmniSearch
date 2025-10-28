import { AssistantReasoning } from "../lib/types";

type ReasoningPanelProps = {
  reasoning?: AssistantReasoning;
};

export function ReasoningPanel({ reasoning }: ReasoningPanelProps) {
  if (!reasoning) return null;

  let originLabel = "Elastic insight";
  let originBadgeClass = "bg-slate-200 text-slate-600";
  if (reasoning.origin === "bedrock") {
    originLabel = "Sonnet insight";
    originBadgeClass = "bg-emerald-100 text-emerald-700";
  } else if (reasoning.origin === "titan-express") {
    originLabel = "Titan Express insight";
    originBadgeClass = "bg-emerald-100 text-emerald-700";
  } else if (reasoning.origin === "titan-premier") {
    originLabel = "Titan Premier insight";
    originBadgeClass = "bg-emerald-100 text-emerald-700";
  } else if (reasoning.origin === "agentcore") {
    originLabel = "AgentCore insight";
    originBadgeClass = "bg-amber-100 text-amber-700";
  }

  return (
    <section className="bg-white shadow-lg border border-slate-200 rounded-2xl p-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Assistant reasoning</h3>
          <span className={`badge ${originBadgeClass}`}>{originLabel}</span>
        </div>
        {reasoning.summary && (
          <p className="text-sm text-slate-900/70 leading-relaxed">{reasoning.summary}</p>
        )}
        {reasoning.details?.length ? (
          <ul className="text-xs text-slate-900/60 space-y-1 list-disc pl-4">
            {reasoning.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
