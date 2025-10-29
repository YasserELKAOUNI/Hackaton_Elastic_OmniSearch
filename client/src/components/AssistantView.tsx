import { useState } from "react";
import { AssistantResponse, PolicyMode, Product } from "../lib/types";
import { ProductCard } from "./ProductCard";
import { ReasoningPanel } from "./ReasoningPanel";
import { motion, AnimatePresence } from "framer-motion";

const shimmer = "bg-gradient-to-r from-white/5 via-white/10 to-white/5 animate-pulse";

function EmptyState() {
  return (
    <div className="bg-white shadow-lg border border-slate-200 rounded-2xl h-full flex flex-col items-center justify-center text-center space-y-3">
      <div className="text-4xl">🧺</div>
      <h3 className="text-lg font-semibold">Awaiting your delicious brief</h3>
      <p className="text-sm text-slate-900/60 max-w-md">
        Ask for something specific like “healthy breakfast for kids under €10” to see AI-ranked results, active promotions, and the reasoning behind each recommendation.
      </p>
    </div>
  );
}

type AssistantViewProps = {
  query: string;
  data?: AssistantResponse;
  isLoading: boolean;
  isError: Error | undefined;
  onRefresh: () => void;
};

export function AssistantView({ query, data, isLoading, isError, onRefresh }: AssistantViewProps) {
  const meta = data?.meta;
  if (isError) {
    return (
      <div className="bg-white shadow-lg border border-slate-200 rounded-2xl p-8 space-y-3">
        <h3 className="text-lg font-semibold text-red-400">Something went wrong</h3>
        <p className="text-sm text-slate-900/70">{isError.message}</p>
        <button className="badge bg-white/10 hover:bg-white/20" onClick={onRefresh}>
          Retry
        </button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[...Array(3)].map((_, index) => (
          <div key={index} className={`h-40 rounded-2xl ${shimmer}`} />
        ))}
      </div>
    );
  }

  if ((!data?.products || data.products.length === 0) && !data?.reasoning?.summary && !data?.reasoning?.details?.length) {
    return <EmptyState />;
  }

  const usingBedrock = meta?.reasoningOrigin === "bedrock";
  const policy = meta?.policyDecision as
    | {
        action?: string;
        resolvedAction?: string;
        confidence?: number;
        reason?: string;
        source?: string;
        policyMode?: PolicyMode;
        context?: { complexityScore?: number; complexitySource?: string; policyMode?: PolicyMode };
      }
    | undefined;
  const policyMode = meta?.policyMode ?? policy?.policyMode ?? policy?.context?.policyMode;
  const complexityScore = policy?.context?.complexityScore;
  const complexitySource = policy?.context?.complexitySource;
  const reasoningModel = meta?.reasoningModel ?? "none";
  const agentCoreActive = Boolean(meta?.agentCore);
  const agentCoreError = meta?.agentCoreError;
  const resolvedAction = policy?.resolvedAction || policy?.action;

  const elasticActive = resolvedAction === "elastic_only";
  const policyActive = policy?.source === "model";
  const bedrockActive = reasoningModel === "bedrock";
  const titanExpressActive = reasoningModel === "titan-express";
  const titanPremierActive = reasoningModel === "titan-premier";

  const productsEmpty = !data?.products || data.products.length === 0;
  const showReasoningPanel = Boolean(data?.reasoning) && !productsEmpty;

  const badgeClass = (active: boolean, tone: "default" | "agent" = "default") => {
    if (tone === "agent") {
      return active
        ? "badge border bg-amber-100 text-amber-700 border-amber-200"
        : "badge border bg-slate-200 text-slate-500 border-slate-300";
    }
    return active
      ? "badge border bg-emerald-100 text-emerald-700 border-emerald-200"
      : "badge border bg-slate-200 text-slate-500 border-slate-300";
  };

  type EngineBadge = {
    label: string;
    active: boolean;
    tone?: "agent" | "default";
  };

  const engineBadges: EngineBadge[] = [
    ...(agentCoreActive
      ? [
          {
            label: "AgentCore",
            active: true,
            tone: "agent" as const,
          },
        ]
      : []),
    {
      label: "Haiku (policy)",
      active: policyActive,
    },
    {
      label: "Elastic",
      active: elasticActive,
    },
    {
      label: "Sonnet",
      active: bedrockActive,
    },
    {
      label: "Titan Express",
      active: titanExpressActive,
    },
    {
      label: "Titan Premier",
      active: titanPremierActive,
    },
  ];

  // Build a clean display label by stripping trailing budget/household clauses
  const effectiveBudget =
    typeof meta?.budgetMaxPrice === "number"
      ? meta?.budgetMaxPrice
      : (meta?.policyDecision?.context?.maxPrice as number | undefined);
  const cleanLabel = (() => {
    try {
      let base = (query || "").trim();
      // Remove common budget phrases to avoid duplication in the title
      base = base.replace(/\s+for\s+\d+\s+people\s+with\s+budget\s+under\s+€\d+(?:[.,]\d+)?/i, "");
      base = base.replace(/\s+with\s+budget\s+under\s+€\d+(?:[.,]\d+)?/i, "");
      base = base.replace(/\s+under\s+€\d+(?:[.,]\d+)?/i, "");
      return base.trim();
    } catch {
      return query;
    }
  })();

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Top picks for “{cleanLabel || query}”</h2>
          <p className="text-sm text-slate-900/60">
            Blending Elastic search relevance, nutrition intelligence, and promotion stacking.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="badge bg-white/10">#{data.products?.length ?? 0}</span>
          {typeof effectiveBudget === "number" ? (
            <span className="badge border bg-slate-200 text-slate-700 border-slate-300">Budget ≤ €{Math.round(effectiveBudget)}</span>
          ) : null}
          {policyMode ? (
            <span className={badgeClass(true)}>
              {policyMode === "fully_managed" ? "Haiku Fully-managed" : "Haiku Semi-managed"}
            </span>
          ) : null}
          {typeof complexityScore === "number" ? (
            <span className="badge border bg-slate-200 text-slate-600 border-slate-300">
              Complexity {complexityScore}
              {complexitySource ? ` · ${complexitySource}` : ""}
            </span>
          ) : null}
          {engineBadges.map((badge) => (
            <span key={badge.label} className={badgeClass(badge.active, badge.tone || "default")}>
              {badge.label}
            </span>
          ))}
          {meta?.budgetAdjustmentApplied ? (
            <span className="badge bg-amber-100 text-amber-700">Budget prioritised</span>
          ) : null}
        </div>
      </header>

      {agentCoreError ? <AgentCoreAlert message={agentCoreError} meta={meta} /> : null}

      {showReasoningPanel ? <ReasoningPanel reasoning={data.reasoning} /> : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {productsEmpty ? (
          <div className="col-span-full rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
            <p>
              {data.reasoning?.summary ||
                "No matching products were found for this query. Try adjusting the wording or relaxing filters."}
            </p>
            {data.reasoning?.details?.length ? (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-500">
                {data.reasoning.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <AnimatePresence mode="popLayout">
            {data.products.map((product) => (
              <motion.div
                layout
                key={product.product_id ?? product.productId ?? product.name}
                initial={{ opacity: 0, translateY: 16 }}
                animate={{ opacity: 1, translateY: 0 }}
                exit={{ opacity: 0, translateY: -16 }}
                transition={{ duration: 0.3 }}
              >
                <ProductCard product={product} promotions={data.promotions} />
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}

type AgentCoreAlertProps = {
  message: string;
  meta?: AssistantResponse["meta"];
};

function AgentCoreAlert({ message, meta }: AgentCoreAlertProps) {
  const [expanded, setExpanded] = useState(false);
  const previewLength = 160;
  const shouldTruncate = message.length > previewLength;
  const previewText = shouldTruncate && !expanded ? `${message.slice(0, previewLength)}…` : message;
  const resolvedActionRaw = meta?.policyDecision?.resolvedAction;
  const resolvedActionLabel = resolvedActionRaw === "elastic_plus_bedrock"
    ? "elastic_plus_sonnet"
    : resolvedActionRaw;

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900 shadow-sm">
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-semibold">AgentCore returned a warning</p>
            <p>{previewText}</p>
          </div>
          {shouldTruncate ? (
            <button
              type="button"
              className="text-xs font-medium text-amber-700 hover:text-amber-900"
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded ? "Show less" : "Show full message"}
            </button>
          ) : null}
        </div>
        <div className="grid gap-2 text-xs text-amber-800 sm:grid-cols-3">
          {resolvedActionLabel ? (
            <div className="rounded-lg border border-amber-200/70 bg-white/80 px-3 py-2">
              <div className="font-semibold uppercase tracking-wide text-[11px] text-amber-600">Resolved action</div>
              <div>{resolvedActionLabel}</div>
            </div>
          ) : null}
          {typeof meta?.policyDecision?.context?.complexityScore === "number" ? (
            <div className="rounded-lg border border-amber-200/70 bg-white/80 px-3 py-2">
              <div className="font-semibold uppercase tracking-wide text-[11px] text-amber-600">Complexity</div>
              <div>
                {meta.policyDecision.context.complexityScore}
                {meta.policyDecision.context.complexitySource
                  ? ` · ${meta.policyDecision.context.complexitySource}`
                  : ""}
              </div>
            </div>
          ) : null}
          {meta?.policyDecision?.reason ? (
            <div className="rounded-lg border border-amber-200/70 bg-white/80 px-3 py-2 sm:col-span-1">
              <div className="font-semibold uppercase tracking-wide text-[11px] text-amber-600">Policy notes</div>
              <div>{meta.policyDecision.reason}</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
