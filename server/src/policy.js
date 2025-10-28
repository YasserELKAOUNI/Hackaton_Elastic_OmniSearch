import { analyseQueryContext, computeComplexityScore } from "./utils/context.js";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import dotenv from "dotenv";

dotenv.config();

const {
  BEDROCK_REGION,
  BEDROCK_POLICY_MODEL_ID,
} = process.env;

export const POLICY_MODES = ["semi_managed", "fully_managed"];

const POLICY_OPTIONS = [
  "elastic_only",
  "elastic_plus_bedrock",
  "elastic_plus_titan_express",
  "elastic_plus_titan_premier",
  "reject_out_of_domain",
];

const policyClient =
  BEDROCK_REGION && BEDROCK_POLICY_MODEL_ID
    ? new BedrockRuntimeClient({ region: BEDROCK_REGION })
    : null;

const CULINARY_QUALIFIERS = [
  "halal",
  "kosher",
  "vegan",
  "vegetarian",
  "gluten",
  "dairy-free",
  "bio",
  "organic",
  "low",
  "less",
  "healthy",
  "kids",
  "allergen",
  "cacao",
  "sugar",
  "protein",
];

/**
 * Placeholder for a future Bedrock policy call.
 * @param {object} payload
 * @returns {Promise<null|{ action: string; confidence?: number; notes?: string }>}
 */
async function callPolicyModel(payload) {
  if (!policyClient) return null;

  const {
    rawQuery,
    expandedQuery,
    translations,
    preferences,
    userBedrockToggle,
    hasBedrockTarget,
    hasTitanExpressTarget,
    hasTitanPremierTarget,
    context,
    dietaryTagCount,
    complexityScore,
    policyMode = "semi_managed",
  } = payload;
  const fullyManaged = policyMode === "fully_managed";
const systemPrompt = `You are the routing agent for Healthy Basket, a grocery assistant. You decide which engine should be used.
Actions (only choose from this list):
- elastic_only: rely on Elastic search heuristics only.
- elastic_plus_bedrock: use Elastic then Claude Sonnet for premium reasoning.
- elastic_plus_titan_express: use Elastic then Amazon Titan Text Express (fast AWS-native reasoning).
- elastic_plus_titan_premier: use Elastic then Amazon Titan Text Premier (highest depth, highest cost).
- reject_out_of_domain: query is outside grocery/retail.

Always respond with compact JSON: {"action":"...", "confidence":0-1, "notes":"...", "complexity":0-10}
${fullyManaged
    ? "Compute the complexity score yourself (0-10) based on the query wording, dietary modifiers, budget mentions, and perceived effort. Do not rely on pre-computed heuristics."
    : "A pre-computed heuristic complexity score is provided; you may use it or adjust if you disagree (return your chosen score in the response)."}
Routing policy:
- Complexity <= 2 with no modifiers -> elastic_only unless the user forces another engine.
- Complexity 3-4 or simple requests with light constraints -> elastic_plus_bedrock (Sonnet) if available.
- Complexity 5-7 (moderate detail, multiple modifiers, or budget + dietary) -> elastic_plus_titan_express, provided the endpoint is available.
- Complexity >= 8 (rich intent, many constraints) -> elastic_plus_titan_premier, but only if the Premier endpoint is available; otherwise fall back to Titan Express or Sonnet according to availability.
- If the user toggled Bedrock in the UI, default to elastic_plus_bedrock unless complexity clearly justifies Titan Express/Premier.
- If an endpoint is unavailable, choose the next best option and mention the reason in notes.
- Keep reject_out_of_domain exclusively for queries clearly outside food, beverage, or household retail.
Pick the single most appropriate action and include your computed complexity integer (0-10).`;

  const translationLine = translations?.length
    ? translations.join(", ")
    : "none";

  const userPrompt = `
Original query: ${rawQuery}
Expanded query: ${expandedQuery}
Added translations: ${translationLine}
Dietary preferences: ${(preferences?.dietaryTags || []).join(", ") || "none"}
Dietary tag count: ${dietaryTagCount}
Budget specified: ${context?.hasBudgetConstraint ? `<= €${context.maxPrice}` : "not specified"}
User toggled Bedrock: ${Boolean(userBedrockToggle)}
Bedrock model available: ${Boolean(hasBedrockTarget)}
Titan Express available: ${Boolean(hasTitanExpressTarget)}
Titan Premier available: ${Boolean(hasTitanPremierTarget)}
Core query (budget suffix removed): ${context?.coreQuery || "(none)"}
Core tokens: ${(context?.coreTokens || []).join(", ") || "none"}
Core token count: ${context?.coreTokenCount ?? 0}
Has budget constraint: ${Boolean(context?.hasBudgetConstraint)}
Complexity score (higher = more complex): ${complexityScore}
Allowed actions: ${POLICY_OPTIONS.join(", ")}
`.trim();

  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 128,
    temperature: 0,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userPrompt }],
      },
    ],
  };

  try {
    const command = new InvokeModelCommand({
      modelId: BEDROCK_POLICY_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    });
    const response = await policyClient.send(command);
    const bodyPayload = JSON.parse(new TextDecoder().decode(response.body));
    const text =
      bodyPayload?.content?.[0]?.text ??
      bodyPayload?.completion ??
      null;
    if (!text) return null;
    const parsed = JSON.parse(text);
    if (!POLICY_OPTIONS.includes(parsed.action)) {
      return null;
    }
    const rawComplexity =
      typeof parsed.complexity === "number"
        ? parsed.complexity
        : typeof parsed.complexity_score === "number"
        ? parsed.complexity_score
        : undefined;
    const normalisedComplexity =
      typeof rawComplexity === "number" && Number.isFinite(rawComplexity)
        ? Math.max(0, Math.min(10, Math.round(rawComplexity)))
        : undefined;
    return {
      action: parsed.action,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
      reason: typeof parsed.notes === "string" ? parsed.notes : undefined,
      source: "model",
      complexityScore: normalisedComplexity,
    };
  } catch (error) {
    console.warn("Policy model call failed, falling back to heuristics:", error.message);
    return null;
  }
}

function basicHeuristicPolicy({
  preferences,
  userBedrockToggle,
  hasBedrockTarget,
  hasTitanExpressTarget,
  hasTitanPremierTarget,
  context,
}) {
  const tokens = context.tokens;
  const baseTokens = context.coreTokens && context.coreTokens.length ? context.coreTokens : tokens;
  const baseTokenCount = baseTokens.length;
  const originalLength = tokens.length;
  const lowerQuery = context.coreQuery || "";
  const dietaryTagCount = Array.isArray(preferences?.dietaryTags) ? preferences.dietaryTags.length : 0;
  const complexityScore =
    (context.complexityScore ?? 0) ||
    baseTokenCount + dietaryTagCount * 2 + (context.hasBudgetConstraint ? 1 : 0);

  const hasDietaryFilters = Array.isArray(preferences?.dietaryTags) && preferences.dietaryTags.length > 0;
  const hasProjectedComplexity =
    tokens.some((token) => CULINARY_QUALIFIERS.includes(token)) ||
    context.hasBudgetConstraint ||
    /%/.test(lowerQuery) ||
    /\bunder\b|\bover\b|\bmoins\b|\bplus\b/.test(lowerQuery) ||
    baseTokenCount >= 4;

  if (!hasDietaryFilters && !hasProjectedComplexity && baseTokenCount <= 2 && !userBedrockToggle) {
    return {
      action: "elastic_only",
      reason: "Short query without modifiers; Elastic heuristics preferred.",
      confidence: 0.7,
      context: {
        ...context,
        complexityScore,
        complexitySource: "heuristic",
      },
    };
  }

  if (!hasBedrockTarget && userBedrockToggle && !hasTitanExpressTarget && !hasTitanPremierTarget) {
    return {
      action: "elastic_only",
      reason: "Bedrock unavailable; falling back to Elastic-only.",
      confidence: 0.6,
      context: {
        ...context,
        complexityScore,
        complexitySource: "heuristic",
      },
    };
  }

  if (hasDietaryFilters || hasProjectedComplexity || userBedrockToggle) {
    if (hasTitanPremierTarget && complexityScore >= 8) {
      return {
        action: "elastic_plus_titan_premier",
        reason: `High complexity score (${complexityScore}) with multiple modifiers; Titan Premier can balance depth and AWS-native guardrails.`,
        confidence: 0.7,
        context: {
          ...context,
          complexityScore,
          complexitySource: "heuristic",
        },
      };
    }
    if (hasTitanExpressTarget && complexityScore >= 5) {
      return {
        action: "elastic_plus_titan_express",
        reason: `Moderate complexity score (${complexityScore}); Titan Express provides quick AWS-native reasoning.`,
        confidence: 0.65,
        context: {
          ...context,
          complexityScore,
          complexitySource: "heuristic",
        },
      };
    }
    if (hasBedrockTarget) {
      return {
        action: "elastic_plus_bedrock",
        reason: "Complex query or preferences detected; Bedrock reasoning recommended.",
        confidence: 0.75,
        context: {
          ...context,
          complexityScore,
          complexitySource: "heuristic",
        },
      };
    }
  }

  return {
    action: "elastic_only",
    reason: "Default to Elastic-only for confident simple search.",
    confidence: 0.6,
    context: {
      ...context,
      complexityScore,
      complexitySource: "heuristic",
    },
  };
}

export async function decidePolicy({
  rawQuery,
  query,
  translations = [],
  preferences,
  userBedrockToggle,
  hasBedrockTarget,
  hasTitanExpressTarget,
  hasTitanPremierTarget,
  policyMode = "semi_managed",
}) {
  const mode = POLICY_MODES.includes(policyMode) ? policyMode : "semi_managed";
  const analysed = analyseQueryContext(query);
  const heuristicComplexity =
    mode === "semi_managed"
      ? computeComplexityScore(analysed, preferences, { userBedrockToggle })
      : undefined;
  const dietaryTagCount = Array.isArray(preferences?.dietaryTags) ? preferences.dietaryTags.length : 0;
  const baseContext = {
    ...analysed,
    translations,
    expandedQuery: query,
    rawQuery,
    ...(typeof heuristicComplexity === "number"
      ? { complexityScore: heuristicComplexity, complexitySource: "heuristic" }
      : {}),
    policyMode: mode,
  };

  const modelSuggestion = await callPolicyModel({
    rawQuery,
    expandedQuery: query,
    translations,
    preferences,
    userBedrockToggle,
    hasBedrockTarget,
    hasTitanExpressTarget,
    hasTitanPremierTarget,
    context: baseContext,
    dietaryTagCount,
    complexityScore: mode === "fully_managed" ? undefined : heuristicComplexity,
    policyMode: mode,
  });

  if (modelSuggestion?.action) {
    const complexityFromModel =
      typeof modelSuggestion.complexityScore === "number"
        ? modelSuggestion.complexityScore
        : baseContext.complexityScore;
    return {
      ...modelSuggestion,
      context: {
        ...baseContext,
        ...(modelSuggestion.context || {}),
        ...(typeof complexityFromModel === "number"
          ? {
              complexityScore: complexityFromModel,
              complexitySource:
                mode === "fully_managed" ? "haiku" : modelSuggestion.source === "model" ? "haiku_adjusted" : "heuristic",
            }
          : {}),
        policyMode: mode,
      },
      policyMode: mode,
      source: modelSuggestion.source ?? "model",
    };
  }

  const heuristicDecision = basicHeuristicPolicy({
    preferences,
    userBedrockToggle,
    hasBedrockTarget,
    hasTitanExpressTarget,
    hasTitanPremierTarget,
    context: baseContext,
  });
  return {
    ...heuristicDecision,
    source: "heuristic",
    policyMode: mode,
    context: {
      ...heuristicDecision.context,
      policyMode: mode,
    },
  };
}
