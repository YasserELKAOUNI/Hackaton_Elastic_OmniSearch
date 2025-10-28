import express from "express";
import morgan from "morgan";
import { BedrockRuntimeClient, InvokeModelCommand, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import dotenv from "dotenv";
import { analyseQueryContext, computeComplexityScore } from "./utils/context.js";
import { decidePolicy, POLICY_MODES } from "./policy.js";
import crypto from "crypto";
import { getAgentCoreConfig, invokeAgentCore, isAgentCoreReady } from "./agentcoreClient.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5050;
const MCP_URL = process.env.MCP_URL;
const MCP_API_KEY = process.env.MCP_API_KEY;
const POLICY_LOG_INDEX = process.env.POLICY_LOG_INDEX || "policy-decisions";
const POLICY_LOG_URL = process.env.POLICY_LOG_URL || null;
const POLICY_LOG_API_KEY = process.env.POLICY_LOG_API_KEY || process.env.MCP_API_KEY || null;
const MCP_BASE_URL = MCP_URL ? new URL(MCP_URL) : null;
const MCP_BASE_ORIGIN = MCP_BASE_URL ? MCP_BASE_URL.origin : null;
const BEDROCK_URL = process.env.BEDROCK_URL;
const BEDROCK_API_KEY = process.env.BEDROCK_API_KEY;
const BEDROCK_REGION = process.env.BEDROCK_REGION;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || "anthropic.claude-3-5-sonnet-20241022-v2:0";
const BEDROCK_INFERENCE_PROFILE_ARN = process.env.BEDROCK_INFERENCE_PROFILE_ARN || null;
const BEDROCK_TITAN_EXPRESS_MODEL_ID = process.env.BEDROCK_TITAN_EXPRESS_MODEL_ID || null;
const BEDROCK_TITAN_PREMIER_MODEL_ID = process.env.BEDROCK_TITAN_PREMIER_MODEL_ID || null;
const bedrockClient = BEDROCK_REGION ? new BedrockRuntimeClient({ region: BEDROCK_REGION }) : null;
const agentCoreConfig = getAgentCoreConfig();
const PRODUCT_TOOL =
  process.env.MCP_PRODUCT_TOOL || "healthy_basket_products";
const PROMOTION_TOOL =
  process.env.MCP_PROMOTION_TOOL || "healthy_basket_promotions";

if (!MCP_URL || !MCP_API_KEY) {
  console.warn(
    "⚠️  MCP_URL and MCP_API_KEY must be configured in your environment or .env file. Requests will fail until these are set."
  );
}

async function logPolicyDecision({
  query,
  preferences,
  policyMeta,
  finalModel,
}) {
  const baseUrl = POLICY_LOG_URL
    ? POLICY_LOG_URL.replace(/\/+$/, "")
    : MCP_BASE_ORIGIN;
  const apiKey = POLICY_LOG_API_KEY;
  if (!baseUrl || !apiKey) return;
  const resolvedAction = policyMeta?.resolvedAction ?? policyMeta?.action ?? null;
  const originalAction = policyMeta?.originalAction ?? policyMeta?.action ?? null;
  try {
    const doc = {
      timestamp: new Date().toISOString(),
      query,
      preferences: Array.isArray(preferences?.dietaryTags)
        ? preferences.dietaryTags
        : [],
      action: resolvedAction,
      resolved_action: resolvedAction,
      original_action: originalAction,
      confidence: typeof policyMeta?.confidence === "number" ? policyMeta.confidence : null,
      reason: policyMeta?.reason ?? null,
      source: policyMeta?.source ?? null,
      policy_mode: policyMeta?.policyMode ?? null,
      complexity_score:
        typeof policyMeta?.context?.complexityScore === "number"
          ? policyMeta.context.complexityScore
          : null,
      complexity_source: policyMeta?.context?.complexitySource ?? null,
      final_model: finalModel ?? null,
    };
    const endpoint = `${baseUrl}/${POLICY_LOG_INDEX}/_doc`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `ApiKey ${apiKey}`,
        "kbn-xsrf": "true",
      },
      body: JSON.stringify(doc),
    });
    if (!response.ok) {
      const text = await response.text();
      console.warn("Policy log failed:", response.status, text);
    }
  } catch (error) {
    console.warn("Failed to log policy decision:", error.message);
  }
}

app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));

let hasInitialised = false;
let rpcCounter = 1;

function safeJsonParse(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

async function reasonWithTitan(modelIdentifier, query, products, promotions, queryContext, originLabel) {
  if (!modelIdentifier || !bedrockClient) {
    const best = products?.[0];
    return {
      summary: best
        ? `Elastic ranking selected ${best.name || "this product"} based on nutrition and savings.`
        : "Elastic ranking ready—enable advanced reasoning to enrich the summary.",
      details: [
        `Heuristic rerank applied across ${products?.length ?? 0} products.`,
        "Advanced reasoning disabled for this request.",
      ],
      origin: "heuristic",
    };
  }

  try {
    const topProducts = products.slice(0, Math.min(products.length, 15)).map((product, index) => {
      const heuristicScore = Number(scoreProduct(query, product).toFixed(3));
      const identifier =
        product.product_id || product.productId || product.sku || product.id || `item-${index + 1}`;
      const description =
        product.description ||
        product.summary ||
        product.shortDescription ||
        product.blurb ||
        null;
      const savingsPercent =
        typeof product.regularPrice === "number" && typeof product.price === "number" && product.regularPrice > 0
          ? ((product.regularPrice - product.price) / product.regularPrice) * 100
          : null;
      return {
        rank: index + 1,
        id: identifier,
        name: product.name,
        brand: product.brand,
        category: product.category,
        subcategory: product.subcategory,
        description,
        price: product.price,
        regularPrice: product.regularPrice,
        savingsPercent: savingsPercent !== null ? Number(savingsPercent.toFixed(2)) : null,
        healthScore: product.healthScore ?? product.nutrition?.health_score,
        promotionIds: product.promotionIds,
        labels: product.labels,
        dietaryTags: Array.isArray(product.dietary_tags)
          ? product.dietary_tags
          : product.dietary_tags
          ? [product.dietary_tags]
          : [],
        nutrition: product.nutrition,
        heuristicScore,
        form: classifyProductForm(product),
        withinBudget:
          queryContext.maxPrice !== null && typeof product.price === "number"
            ? product.price <= queryContext.maxPrice
            : null,
        overBudget:
          queryContext.maxPrice !== null && typeof product.price === "number"
            ? product.price > queryContext.maxPrice
            : null,
      };
    });

    const topPromos = promotions.slice(0, 6).map((promo) => ({
      id: promo.promotion_id || promo.promotionId,
      title: promo.title,
      discount: promo.discount_percent,
      description: promo.description,
    }));

    const prompt = `
You are an assistant that reranks grocery products. Consider query relevance, dietary preferences, budget constraints, health scores, and savings.
Return minified JSON: {"summary": "...", "details": ["..."], "product_ranking": [{"product_id": "...", "score": 0-1}] }.
Avoid extra text.

Query: ${query}
Dietary preferences: ${(queryContext?.preferences?.dietaryTags || []).join(", ") || "none"}
Budget: ${queryContext?.maxPrice !== null ? `<= €${queryContext.maxPrice}` : "not specified"}
Products: ${JSON.stringify(topProducts)}
Promotions: ${JSON.stringify(topPromos)}
`.trim();

    let textResponse = null;
    const isNovaProfile =
      typeof modelIdentifier === "string" &&
      (modelIdentifier.includes("nova") || modelIdentifier.includes("inference-profile/us.amazon.nova"));

    if (isNovaProfile) {
      const converseParams = {
        modelId: modelIdentifier,
        messages: [
          {
            role: "user",
            content: [{ text: prompt }],
          },
        ],
        inferenceConfig: {
          maxTokens: 640,
          temperature: 0.2,
          topP: 0.9,
        },
      };
      const command = new ConverseCommand(converseParams);
      const response = await bedrockClient.send(command);
      const content = response?.output?.message?.content || [];
      const textPart = content.find((part) => typeof part?.text === "string");
      textResponse = textPart?.text ?? null;
    } else {
      const body = {
        inputText: prompt,
        textGenerationConfig: {
          maxTokenCount: 640,
          temperature: 0.2,
          topP: 0.9,
        },
      };

      const invokeParams = {
        modelId: modelIdentifier,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(body),
      };
      if (typeof modelIdentifier === "string" && modelIdentifier.startsWith("arn:") && modelIdentifier.includes(":inference-profile/")) {
        invokeParams.inferenceProfileArn = modelIdentifier;
      }

      const command = new InvokeModelCommand(invokeParams);
      const response = await bedrockClient.send(command);
      const payload = JSON.parse(new TextDecoder().decode(response.body));
      textResponse = payload?.results?.[0]?.outputText ?? null;
    }

    if (!textResponse) {
      throw new Error("Titan response missing output text.");
    }

    let parsed = safeJsonParse(textResponse);
    if (!parsed) {
      const start = textResponse.indexOf("{");
      const end = textResponse.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        parsed = safeJsonParse(textResponse.slice(start, end + 1));
      }
    }

    let summary =
      typeof parsed?.summary === "string" && parsed.summary.trim().length
        ? parsed.summary.trim()
        : null;

    let details = Array.isArray(parsed?.details)
      ? parsed.details
          .filter((item) => typeof item === "string" && item.trim().length > 0)
          .slice(0, 4)
      : [];

    const productRanking = Array.isArray(parsed?.product_ranking)
      ? parsed.product_ranking
          .map((entry) => {
            if (!entry || typeof entry !== "object") return null;
            const productId =
              typeof entry.product_id === "string"
                ? entry.product_id
                : typeof entry.productId === "string"
                ? entry.productId
                : typeof entry.id === "string"
                ? entry.id
                : null;
            const name =
              typeof entry.name === "string"
                ? entry.name.trim()
                : typeof entry.product_name === "string"
                ? entry.product_name.trim()
                : typeof entry.title === "string"
                ? entry.title.trim()
                : null;
            if (!productId && !name) return null;
            const rawScore =
              entry.score !== undefined
                ? entry.score
                : entry.weight !== undefined
                ? entry.weight
                : entry.confidence;
            let score =
              typeof rawScore === "number"
                ? rawScore
                : typeof rawScore === "string"
                ? Number(rawScore)
                : null;
            if (typeof score === "number" && Number.isFinite(score)) {
              score = Math.max(0, Math.min(1, score));
            } else {
              score = null;
            }
            const rationale =
              typeof entry.rationale === "string" && entry.rationale.trim().length > 0
                ? entry.rationale.trim()
                : null;
            return {
              productId: productId ?? null,
              name: name ?? null,
              score,
              rationale,
            };
          })
          .filter(Boolean)
      : [];

    if (!summary) {
      const lines =
        typeof textResponse === "string"
          ? textResponse
              .split(/\n+/)
              .map((line) => line.trim())
              .filter((line) => line && !/^[\{\}\[\]]$/.test(line))
          : [];
      const summaryLine =
        lines.find((line) => /^"summary"\s*:/.test(line)) || lines.shift();
      if (summaryLine) {
        summary = summaryLine.replace(/^"summary"\s*:\s*/i, "").replace(/^"|"$/g, "").trim();
      }
      if (!summary) {
        summary = lines.shift() || "Advanced reasoning unavailable.";
      }
      if (!details.length) {
        const detailLines = lines
          .map((line) => line.replace(/^[\-,\s"]+|[\s",]+$/g, ""))
          .filter((line) => line.length > 0 && !/^"summary"/i.test(line))
          .slice(0, 4);
        if (detailLines.length) {
          details = detailLines;
        }
      }
    }

    details = details.map((detail) => detail.replace(/^[\{\[]+|[\}\]]+$/g, "").trim()).filter(Boolean);

    return {
      summary,
      details,
      origin: originLabel,
      productRanking: productRanking.length ? productRanking : undefined,
      queryContext,
    };
  } catch (error) {
    console.warn(`Titan (${originLabel}) reasoning failed, falling back to heuristics:`, error.message);
    return {
      summary: "Advanced reasoning unavailable; falling back to Elastic heuristics.",
      details: [error.message],
      origin: "heuristic",
    };
  }
}

function classifyProductForm(product) {
  const aggregateText = [
    product?.name,
    product?.category,
    product?.subcategory,
    ...(Array.isArray(product?.labels) ? product.labels : []),
    product?.description,
    product?.summary,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const isSauce = /sauce|passata|puree|purée|paste|ketchup|coulis|condiment|gazpacho/.test(aggregateText);
  const isPrepared =
    isSauce || /mix|jar|bottle|ready|prepared|seasoning|marinade|spread/.test(aggregateText);
  const isFreshCategory =
    typeof product?.category === "string" &&
    /fruit|vegetable/.test(product.category.toLowerCase()) &&
    !/sauce|prepared/.test((product?.subcategory || "").toLowerCase());

  if (isSauce) return "prepared_sauce";
  if (isFreshCategory && !isPrepared) return "whole_produce";
  if (isPrepared) return "prepared";
  return "unknown";
}

function normalisePreferences(raw) {
  const preferences = raw && typeof raw === "object" ? raw : {};
  const dietaryTags = new Set();
  const pushTag = (tag) => {
    if (typeof tag !== "string") return;
    const normalised = tag.trim().toLowerCase();
    if (!normalised) return;
    dietaryTags.add(normalised.replace(/[\s-]+/g, "_"));
  };
  if (Array.isArray(preferences.dietaryTags)) {
    preferences.dietaryTags.forEach(pushTag);
  }
  if (typeof preferences.dietary === "string") {
    preferences.dietary.split(/[,\s]+/).forEach(pushTag);
  }
  return {
    dietaryTags: Array.from(dietaryTags),
  };
}

function transformTabularData(data) {
  const columns = Array.isArray(data.columns) ? data.columns : [];
  const rows = Array.isArray(data.values) ? data.values : [];
  return rows.map((values = []) => {
    const entry = {};
    columns.forEach((column, index) => {
      const key =
        typeof column?.name === "string" && column.name.length > 0
          ? column.name
          : `column_${index}`;
      entry[key] = values[index];
    });
    return entry;
  });
}

function expandDotNotation(source) {
  if (typeof source !== "object" || source === null) return {};
  const target = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof key === "string" && key.includes(".")) {
      const parts = key.split(".");
      let current = target;
      parts.forEach((part, index) => {
        if (index === parts.length - 1) {
          current[part] = value;
        } else {
          current[part] = current[part] || {};
          current = current[part];
        }
      });
    }
  }
  return target;
}

async function callMCP(method, params) {
  if (!MCP_URL || !MCP_API_KEY) {
    throw new Error("MCP server credentials are not configured.");
  }

  const payload = {
    jsonrpc: "2.0",
    id: rpcCounter++,
    method,
  };

  if (params !== undefined) {
    payload.params = params;
  }

  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `ApiKey ${MCP_API_KEY}`,
      "kbn-xsrf": "true",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MCP request failed (${response.status}): ${text}`);
  }

  const result = await response.json();
  if (result.error) {
    throw new Error(`MCP error ${result.error.code}: ${result.error.message}`);
  }
  return result.result;
}

async function ensureInitialised() {
  if (hasInitialised) {
    return;
  }
  await callMCP("initialize", {
    clientInfo: { name: "healthy-basket-proxy", version: "1.0.0" },
    capabilities: {},
    protocolVersion: "2024-11-05",
  });
  hasInitialised = true;
}

async function callTool(name, args) {
  await ensureInitialised();
  return callMCP("tools/call", {
    name,
    arguments: args,
  });
}

function flattenContent(result) {
  if (!result) return [];
  if (Array.isArray(result)) {
    return result.flatMap(flattenContent);
  }

  if (result.type === "tabular_data" && result.data) {
    return transformTabularData(result.data);
  }

  if (result.data) {
    if (result.data.content) return flattenContent(result.data.content);
    if (Array.isArray(result.data.results))
      return flattenContent(result.data.results);
    if (result.data.columns && result.data.values) {
      return transformTabularData(result.data);
    }
  }

  const { content, documents, results } = result;
  if (Array.isArray(content)) {
    return content.flatMap((block) => {
      if (typeof block === "string") return [{ insight: block }];
      if (block?.type === "text" && typeof block.text === "string") {
        try {
          const parsed = JSON.parse(block.text);
          return flattenContent(parsed);
        } catch (err) {
          return [{ insight: block.text }];
        }
      }
      if (block?.type === "tabular_data" && block?.data) {
        return transformTabularData(block.data);
      }
      if (block?.type === "resource" && block?.data?.content) {
        return flattenContent(block.data.content);
      }
      return flattenContent(block);
    });
  }
  if (Array.isArray(documents)) return documents.flatMap(flattenContent);
  if (Array.isArray(results)) return results.flatMap(flattenContent);
  return [result];
}

async function reasonWithBedrock(query, products, promotions, useBedrock, queryContext = analyseQueryContext(query)) {
  const profilePreferences = queryContext?.preferences || { dietaryTags: [] };
  const hasBedrockTarget = BEDROCK_INFERENCE_PROFILE_ARN || BEDROCK_MODEL_ID;
  const bedrockEnabled = Boolean(useBedrock && bedrockClient && hasBedrockTarget);
  if (!bedrockEnabled) {
    const best = products?.[0];
    return {
      summary: best
        ? `Elastic ranking selected ${best.name || "this product"} based on nutrition and savings.`
        : "Elastic ranking ready—enable Bedrock to generate a tailored explanation.",
      details: [
        `Heuristic rerank applied across ${products?.length ?? 0} products.`,
        "Bedrock disabled for this request.",
      ],
      origin: "heuristic",
      queryContext,
      preferences: profilePreferences,
    };
  }

  try {
    const topProducts = products.slice(0, Math.min(products.length, 15)).map((product, index) => {
      const heuristicScore = Number(scoreProduct(query, product).toFixed(3));
      const identifier =
        product.product_id || product.productId || product.sku || product.id || `item-${index + 1}`;
      const description =
        product.description ||
        product.summary ||
        product.shortDescription ||
        product.blurb ||
        null;
      const savingsPercent =
        typeof product.regularPrice === "number" && typeof product.price === "number" && product.regularPrice > 0
          ? ((product.regularPrice - product.price) / product.regularPrice) * 100
          : null;
      return {
        rank: index + 1,
        id: identifier,
        name: product.name,
        brand: product.brand,
        category: product.category,
        subcategory: product.subcategory,
        description,
        price: product.price,
        regularPrice: product.regularPrice,
        savingsPercent: savingsPercent !== null ? Number(savingsPercent.toFixed(2)) : null,
        healthScore: product.healthScore ?? product.nutrition?.health_score,
        promotionIds: product.promotionIds,
        labels: product.labels,
        dietaryTags: Array.isArray(product.dietary_tags)
          ? product.dietary_tags
          : product.dietary_tags
          ? [product.dietary_tags]
          : [],
        nutrition: product.nutrition,
        heuristicScore,
        form: classifyProductForm(product),
        withinBudget:
          queryContext.maxPrice !== null && typeof product.price === "number"
            ? product.price <= queryContext.maxPrice
            : null,
        overBudget:
          queryContext.maxPrice !== null && typeof product.price === "number"
            ? product.price > queryContext.maxPrice
            : null,
        nameMatchCount: queryContext.tokens.filter(
          (token) => token.length > 2 && (product.name || "").toLowerCase().includes(token)
        ).length,
        descriptionMatchCount:
          description && queryContext.tokens.length
            ? queryContext.tokens.filter(
                (token) => token.length > 2 && description.toLowerCase().includes(token)
              ).length
            : 0,
        labelMatches: Array.isArray(product.labels)
          ? product.labels.filter((label) =>
              typeof label === "string" &&
              queryContext.tokens.some((token) => token.length > 2 && label.toLowerCase().includes(token))
            ).length
          : 0,
        categoryMatch: queryContext.tokens.some(
          (token) =>
            token.length > 2 &&
            ((product.category || "").toLowerCase().includes(token) ||
              (product.subcategory || "").toLowerCase().includes(token))
        ),
        hasPromotion: Array.isArray(product.promotionIds) && product.promotionIds.length > 0,
      };
    });

    const topPromos = promotions.slice(0, 6).map((promo) => ({
      id: promo.promotion_id || promo.promotionId,
      title: promo.title,
      discount: promo.discount_percent,
      description: promo.description,
    }));

    const systemPrompt = `
You are an assistant that reranks grocery products. Prioritise ranking by matching the shopper query to product name, brand, category, labels, and description. Use the provided form classifications: prefer \`whole_produce\` items when the shopper asks for the ingredient itself (and \`queryContext.mentionsSauce\` is false), and reserve \`prepared_sauce\` or other processed forms for later unless the query explicitly mentions sauces.
Honour the shopper budget: \`queryContext.maxPrice\` is the maximum acceptable price per item. Keep over-budget items at the end unless no products fit.
After relevance, favour higher health scores and, as a tertiary signal, stronger savings or active promotions.
Respond ONLY with valid minified JSON using this schema:
{
  "summary": string,
  "details": string[],
  "product_ranking": [
    { "product_id": string, "name"?: string, "score"?: number (0-1), "rationale"?: string }
  ]
}
- "summary" should be a one-paragraph explanation (<=280 characters).
- "details" should contain up to 4 short bullet strings.
- "product_ranking" must include the provided product identifiers ("id") in priority order. If you truly cannot recall an id, fall back to the exact product "name".
- Use the provided "heuristicScore" and "rank" fields as context only; you may deviate if you find a more relevant product.
- Always place clearly irrelevant products at the end even if they had high heuristic scores.
- Omit any fields you cannot populate instead of inventing values.
`.trim();
    const userPrompt = `User query: ${query}
Products: ${JSON.stringify(topProducts)}
Promotions: ${JSON.stringify(topPromos)}
Provide a one-paragraph summary and optionally bullet reasons.`;
    const enrichedUserPrompt = `${userPrompt}

Query context: ${JSON.stringify(queryContext)}
Profile preferences: ${JSON.stringify(profilePreferences)}
`.trim();

    const body = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 640,
      temperature: 0.2,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: enrichedUserPrompt }],
        },
      ],
    };

    const inferenceProfileId = BEDROCK_INFERENCE_PROFILE_ARN
      ? BEDROCK_INFERENCE_PROFILE_ARN.split("/").pop()
      : null;
    const modelIdentifier = inferenceProfileId || BEDROCK_MODEL_ID;

    const command = new InvokeModelCommand({
      inferenceProfileArn: BEDROCK_INFERENCE_PROFILE_ARN || undefined,
      modelId: modelIdentifier,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    });

    const response = await bedrockClient.send(command);
    const payload = JSON.parse(new TextDecoder().decode(response.body));
    const textResponse =
      payload?.content?.[0]?.text ?? payload?.completion ?? "Bedrock response unavailable.";

    let parsed = safeJsonParse(textResponse);
    if (!parsed && typeof textResponse === "string") {
      const start = textResponse.indexOf("{");
      const end = textResponse.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        parsed = safeJsonParse(textResponse.slice(start, end + 1));
      }
    }
    if (!parsed) {
      console.warn(
        "Bedrock returned non-JSON payload, applying fallback parsing:",
        typeof textResponse === "string" ? textResponse.slice(0, 300) : textResponse
      );
    }

    let summary =
      typeof parsed?.summary === "string" && parsed.summary.trim().length
        ? parsed.summary.trim()
        : null;

    let details = Array.isArray(parsed?.details)
      ? parsed.details
          .filter((item) => typeof item === "string" && item.trim().length > 0)
          .slice(0, 4)
      : [];

    const productRanking = Array.isArray(parsed?.product_ranking)
      ? parsed.product_ranking
          .map((entry) => {
            if (!entry || typeof entry !== "object") return null;
            const productId =
              typeof entry.product_id === "string"
                ? entry.product_id
                : typeof entry.productId === "string"
                ? entry.productId
                : typeof entry.id === "string"
                ? entry.id
                : null;
            const name =
              typeof entry.name === "string"
                ? entry.name.trim()
                : typeof entry.product_name === "string"
                ? entry.product_name.trim()
                : typeof entry.title === "string"
                ? entry.title.trim()
                : null;
            if (!productId && !name) return null;
            const rawScore =
              entry.score !== undefined
                ? entry.score
                : entry.weight !== undefined
                ? entry.weight
                : entry.confidence;
            let score =
              typeof rawScore === "number"
                ? rawScore
                : typeof rawScore === "string"
                ? Number(rawScore)
                : null;
            if (typeof score === "number" && Number.isFinite(score)) {
              score = Math.max(0, Math.min(1, score));
            } else {
              score = null;
            }
            const rationale =
              typeof entry.rationale === "string" && entry.rationale.trim().length > 0
                ? entry.rationale.trim()
                : null;
            return {
              productId: productId ?? null,
              name: name ?? null,
              score,
              rationale,
            };
          })
          .filter(Boolean)
      : [];

    if (!summary) {
      if (typeof textResponse === "string") {
        const summaryMatch = textResponse.match(/"summary"\s*:\s*"([^"]+)"/s);
        if (summaryMatch && summaryMatch[1]) {
          summary = summaryMatch[1].trim();
        }
      }
    }

    if (!details.length && typeof textResponse === "string") {
      const detailsMatch = textResponse.match(/"details"\s*:\s*\[(.*?)\]/s);
      if (detailsMatch && detailsMatch[1]) {
        const itemMatches = detailsMatch[1].match(/"([^"]+)"/g);
        if (itemMatches) {
          details = itemMatches
            .map((item) => item.replace(/^"|"$/g, "").trim())
            .filter((item) => item.length > 0)
            .slice(0, 4);
        }
      }
    }

    if (!summary) {
      const lines =
        typeof textResponse === "string"
          ? textResponse
              .split(/\n+/)
              .map((line) => line.trim())
              .filter((line) => line && !/^[\{\}\[\]]$/.test(line))
          : [];
      const summaryLine =
        lines.find((line) => /^"summary"\s*:/.test(line)) || lines.shift();
      if (summaryLine) {
        summary = summaryLine.replace(/^"summary"\s*:\s*/i, "").replace(/^"|"$/g, "").trim();
      }
      if (!summary) {
        summary = lines.shift() || "Bedrock response unavailable.";
      }
      if (!details.length) {
        const detailLines = lines
          .map((line) => line.replace(/^[\-,\s"]+|[\s",]+$/g, ""))
          .filter((line) => line.length > 0 && !/^"summary"/i.test(line))
          .slice(0, 4);
        if (detailLines.length) {
          details = detailLines;
        }
      }
    }

    details = details.map((detail) => detail.replace(/^[\{\[]+|[\}\]]+$/g, "").trim()).filter(Boolean);

    return {
      summary,
      details,
      origin: "bedrock",
      productRanking: productRanking.length ? productRanking : undefined,
      queryContext,
      preferences: profilePreferences,
    };
  } catch (error) {
    console.warn("Bedrock reasoning failed, falling back to heuristics:", error.message);
    return {
      summary: "Bedrock reasoning unavailable; falling back to Elastic heuristics.",
      details: [error.message],
      origin: "heuristic",
      queryContext,
      preferences: profilePreferences,
    };
  }
}

function normaliseProduct(raw) {
  if (!raw) return null;
  if (raw._source) return normaliseProduct(raw._source);
  if (raw.product) return normaliseProduct(raw.product);
  if (raw.data) {
    if (raw.data.content) return normaliseProduct(raw.data.content);
    if (raw.data.document) return normaliseProduct(raw.data.document);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed.length) return null;
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        return normaliseProduct(parsed);
      } catch (error) {
        return null;
      }
    }
    if (trimmed.includes("|") || trimmed.toLowerCase().includes("query")) {
      return null;
    }
    return null;
  }
  const product = { ...raw, ...expandDotNotation(raw) };
  const pricing =
    product.pricing ||
    expandDotNotation({
      "pricing.current_price": raw["pricing.current_price"],
      "pricing.regular_price": raw["pricing.regular_price"],
      "pricing.promotion_ids": raw["pricing.promotion_ids"],
      "pricing.price_per_unit.value": raw["pricing.price_per_unit.value"],
      "pricing.price_per_unit.unit": raw["pricing.price_per_unit.unit"],
    }).pricing ||
    {};

  const nutrition =
    product.nutrition ||
    expandDotNotation({
      "nutrition.health_score": raw["nutrition.health_score"],
      "nutrition.nutri_score": raw["nutrition.nutri_score"],
    }).nutrition ||
    {};

  const updatedProduct = {
    ...product,
    product_id:
      product.product_id ?? product.productId ?? product.sku ?? raw.product_id,
    name: product.name ?? product.keyword ?? raw.name ?? raw.keyword ?? null,
    brand: product.brand ?? raw.brand ?? null,
    category: product.category ?? raw.category ?? null,
    subcategory: product.subcategory ?? raw.subcategory ?? null,
    pricing: {
      ...pricing,
      current_price:
        typeof pricing.current_price === "number"
          ? pricing.current_price
          : typeof pricing.current_price === "string"
          ? Number(pricing.current_price)
          : pricing.current_price ?? null,
      regular_price:
        typeof pricing.regular_price === "number"
          ? pricing.regular_price
          : typeof pricing.regular_price === "string"
          ? Number(pricing.regular_price)
          : pricing.regular_price ?? null,
    },
    nutrition: nutrition,
  };

  updatedProduct.dietary_tags =
    Array.isArray(product.dietary_tags)
      ? product.dietary_tags
      : Array.isArray(raw.dietary_tags)
      ? raw.dietary_tags
      : Array.isArray(product.dietaryTags)
      ? product.dietaryTags
      : Array.isArray(raw.dietaryTags)
      ? raw.dietaryTags
      : updatedProduct.dietary_tags ?? [];
  if (!Array.isArray(updatedProduct.dietary_tags)) {
    updatedProduct.dietary_tags = [updatedProduct.dietary_tags].filter(
      (tag) => typeof tag === "string" && tag.trim().length
    );
  } else {
    updatedProduct.dietary_tags = updatedProduct.dietary_tags
      .filter((tag) => typeof tag === "string" && tag.trim().length)
      .map((tag) => tag.trim());
  }

  updatedProduct.price = updatedProduct.pricing?.current_price ?? null;
  updatedProduct.regularPrice = updatedProduct.pricing?.regular_price ?? null;
  updatedProduct.healthScore =
    updatedProduct.nutrition?.health_score ??
    raw.healthScore ??
    updatedProduct.healthScore ??
    null;
  updatedProduct.promotionIds =
    updatedProduct.pricing?.promotion_ids ??
    raw.promotion_ids ??
    updatedProduct.promotionIds ??
    [];

  const hasMeaningfulData =
    updatedProduct.name ||
    updatedProduct.price !== null ||
    updatedProduct.brand ||
    updatedProduct.category;

  if (!hasMeaningfulData) {
    return null;
  }

  return updatedProduct;
}

function normalisePromotion(raw) {
  if (!raw) return null;
  if (raw._source) return normalisePromotion(raw._source);
  if (raw.promotion) return normalisePromotion(raw.promotion);
  if (raw.data) {
    if (raw.data.content) return normalisePromotion(raw.data.content);
    if (raw.data.document) return normalisePromotion(raw.data.document);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed.length) return null;
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        return normalisePromotion(parsed);
      } catch (error) {
        return null;
      }
    }
    return null;
  }
  const promotion = { ...raw, ...expandDotNotation(raw) };
  if (promotion.highlights && !promotion.title) {
    const firstHighlight = Array.isArray(promotion.highlights)
      ? promotion.highlights[0]
      : null;
    if (typeof firstHighlight === "string") {
      promotion.title = firstHighlight.replace(/<[^>]+>/g, "");
    }
  }
  return {
    ...promotion,
    promotion_id:
      promotion.promotion_id ??
      promotion.promotionId ??
      raw.promotion_id ??
      raw.promotionId ??
      null,
    title: promotion.title ?? raw.title ?? promotion.description ?? null,
    discount_percent:
      promotion.discount_percent ??
      raw.discount_percent ??
      promotion.discount ??
      null,
    start_date: promotion.start_date ?? raw.start_date ?? null,
    end_date: promotion.end_date ?? raw.end_date ?? null,
    eligible_products: Array.isArray(promotion.eligible_products)
      ? promotion.eligible_products
      : Array.isArray(raw.eligible_products)
      ? raw.eligible_products
      : typeof promotion.eligible_products === "string"
      ? [promotion.eligible_products]
      : typeof raw.eligible_products === "string"
      ? [raw.eligible_products]
      : promotion.products ?? [],
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", mcpConfigured: Boolean(MCP_URL && MCP_API_KEY) });
});

app.post("/api/assistant", async (req, res) => {
  const {
    nlQuery,
    size = 20,
    rerank = false,
    useBedrock = false,
    preferences: rawPreferences = {},
    policyMode: requestedPolicyMode,
    useAgentCore: useAgentCoreRequested = false,
  } = req.body || {};
  if (!nlQuery || typeof nlQuery !== "string") {
    return res.status(400).json({ error: "nlQuery is required" });
  }

  try {
    const preferences = normalisePreferences(rawPreferences);
    const wantsAgentCore = Boolean(useAgentCoreRequested);
    let agentCoreFallbackReason = null;

    if (wantsAgentCore) {
      if (!isAgentCoreReady()) {
        agentCoreFallbackReason = agentCoreConfig.enabled
          ? "AgentCore requested but not fully configured; fell back to in-app routing."
          : "AgentCore requested but disabled on the server.";
      } else {
        try {
          const agentResponse = await invokeAgentCore({
            query: nlQuery,
            preferences,
            size,
            policyMode: requestedPolicyMode,
            useBedrock,
            rerank,
          });
          return res.json(agentResponse);
        } catch (agentError) {
          console.error("AgentCore invocation failed, falling back to legacy pipeline:", agentError);
          agentCoreFallbackReason =
            agentError instanceof Error ? agentError.message : "Unknown AgentCore error.";
        }
      }
    }

    const PREMIER_THRESHOLD = 8;
    const EXPRESS_THRESHOLD = 5;
    const policyMode = POLICY_MODES.includes(requestedPolicyMode)
      ? requestedPolicyMode
      : "semi_managed";
    const hasActiveDietaryFilters = preferences.dietaryTags.length > 0;
    const hasBedrockTarget = Boolean(BEDROCK_INFERENCE_PROFILE_ARN || BEDROCK_MODEL_ID);
    const hasTitanExpressTarget = Boolean(BEDROCK_TITAN_EXPRESS_MODEL_ID);
    const hasTitanPremierTarget = Boolean(BEDROCK_TITAN_PREMIER_MODEL_ID);
    const policyDecision = await decidePolicy({
      rawQuery: nlQuery,
      query: nlQuery,
      translations: [],
      preferences,
      userBedrockToggle: Boolean(useBedrock),
      hasBedrockTarget,
      hasTitanExpressTarget,
      hasTitanPremierTarget,
      policyMode,
    });
    let policyMeta = { ...policyDecision, resolvedAction: policyDecision.action };
    const addPolicyNote = (message) => {
      policyMeta = {
        ...policyMeta,
        reason: policyMeta.reason ? `${policyMeta.reason} ${message}` : message,
      };
    };

    if (agentCoreFallbackReason) {
      addPolicyNote(agentCoreFallbackReason);
    }

    if (policyDecision.action === "reject_out_of_domain") {
      const rejectMeta = { ...policyDecision, resolvedAction: policyDecision.action };
      logPolicyDecision({
        query: nlQuery,
        preferences,
        policyMeta: rejectMeta,
        finalModel: "none",
      });
      return res.json({
        query: nlQuery,
        products: [],
        promotions: [],
        reasoning: {
          summary: "This assistant focuses on grocery and household queries.",
          details: [policyDecision.reason || "Try a food or retail related question."],
          origin: "heuristic",
        },
        meta: {
          agentCore: false,
          ...(agentCoreFallbackReason ? { agentCoreError: agentCoreFallbackReason } : {}),
          policyDecision: rejectMeta,
          policyMode,
        },
      });
    }

    const [productResult, promoResult] = await Promise.allSettled([
      callTool(PRODUCT_TOOL, { query: nlQuery, size }),
      callTool(PROMOTION_TOOL, { query: nlQuery, size }),
    ]);

    const productDocs =
      productResult.status === "fulfilled" ? flattenContent(productResult.value) : [];
    const promoDocs =
      promoResult.status === "fulfilled" ? flattenContent(promoResult.value) : [];

    const normalisedProducts = productDocs.map(normaliseProduct).filter(Boolean);
    const preferenceResult = applyPreferenceFilters(normalisedProducts, preferences);
    const preferenceFallbackApplied = preferenceResult.applied && preferenceResult.matched === 0;
    let preferenceFallbackMessage = null;
    let preferencePool = preferenceResult.filtered;

    if (preferenceFallbackApplied) {
      preferenceFallbackMessage =
        preferenceResult.tags.length === 1
          ? `No products matched the ${preferenceResult.tags[0].replace(/_/g, " ")} filter; showing closest alternatives instead.`
          : `No products matched all selected filters (${preferenceResult.tags
              .map((tag) => tag.replace(/_/g, " "))
              .join(", ")}); showing broader results instead.`;
      preferencePool = normalisedProducts;
      policyMeta = {
        ...policyMeta,
        reason: policyMeta.reason || preferenceFallbackMessage,
      };
    }

    const originalAction = policyDecision.action;
    let resolvedAction = originalAction === "elastic_plus_bedrock" ? "elastic_plus_sonnet" : originalAction;

    if (
      policyMode !== "fully_managed" &&
      !hasActiveDietaryFilters &&
      (policyMeta.context?.coreTokenCount ?? 0) <= 2 &&
      !useBedrock
    ) {
      resolvedAction = "elastic_only";
    }

    const availabilitySwap = (requested, fallback) => {
      if (requested === fallback) return;
      addPolicyNote(`Requested ${requested} but required endpoint unavailable; routing to ${fallback}.`);
      resolvedAction = fallback;
    };

    if (resolvedAction === "elastic_plus_sonnet" && !hasBedrockTarget) {
      if (hasTitanPremierTarget) availabilitySwap("elastic_plus_sonnet", "elastic_plus_titan_premier");
      else if (hasTitanExpressTarget) availabilitySwap("elastic_plus_sonnet", "elastic_plus_titan_express");
      else availabilitySwap("elastic_plus_sonnet", "elastic_only");
    } else if (resolvedAction === "elastic_plus_titan_express" && !hasTitanExpressTarget) {
      if (hasBedrockTarget) availabilitySwap("elastic_plus_titan_express", "elastic_plus_sonnet");
      else if (hasTitanPremierTarget) availabilitySwap("elastic_plus_titan_express", "elastic_plus_titan_premier");
      else availabilitySwap("elastic_plus_titan_express", "elastic_only");
    } else if (resolvedAction === "elastic_plus_titan_premier" && !hasTitanPremierTarget) {
      if (hasBedrockTarget) availabilitySwap("elastic_plus_titan_premier", "elastic_plus_sonnet");
      else if (hasTitanExpressTarget) availabilitySwap("elastic_plus_titan_premier", "elastic_plus_titan_express");
      else availabilitySwap("elastic_plus_titan_premier", "elastic_only");
    }

    if (resolvedAction === "elastic_only" && useBedrock) {
      if (hasBedrockTarget) resolvedAction = "elastic_plus_sonnet";
      else if (hasTitanExpressTarget) resolvedAction = "elastic_plus_titan_express";
      else if (hasTitanPremierTarget) resolvedAction = "elastic_plus_titan_premier";
    }

    const usesAdvancedModel = ["elastic_plus_sonnet", "elastic_plus_titan_express", "elastic_plus_titan_premier"].includes(resolvedAction);
    const heuristicsProducts = rerank ? rerankProducts(nlQuery, preferencePool) : preferencePool;
    const candidateLimit = usesAdvancedModel ? Math.max(size, 20) : size;
    const candidates = heuristicsProducts.slice(0, candidateLimit);
    const promotions = promoDocs.map(normalisePromotion).filter(Boolean);

    const policyContext = policyDecision.context || analyseQueryContext(nlQuery);
    const queryContext = { ...policyContext, preferences };
    const policyComplexity =
      typeof policyContext?.complexityScore === "number" ? policyContext.complexityScore : undefined;
    const complexityScore =
      typeof policyComplexity === "number"
        ? policyComplexity
        : policyMode === "semi_managed"
        ? computeComplexityScore(policyContext, preferences, { userBedrockToggle: useBedrock })
        : undefined;
    policyMeta = {
      ...policyMeta,
      context: {
        ...policyContext,
        ...(typeof complexityScore === "number" ? { complexityScore } : {}),
        policyMode,
      },
    };
    const queryForLLM = nlQuery;

    if (
      policyMode !== "fully_managed" &&
      typeof complexityScore === "number" &&
      resolvedAction === "elastic_plus_titan_premier" &&
      complexityScore < PREMIER_THRESHOLD
    ) {
      if (hasTitanExpressTarget && complexityScore >= EXPRESS_THRESHOLD) {
        resolvedAction = "elastic_plus_titan_express";
      } else if (hasBedrockTarget) {
        resolvedAction = "elastic_plus_sonnet";
      } else {
        resolvedAction = "elastic_only";
      }
      const note = `Complexity score ${complexityScore} below Premier threshold (${PREMIER_THRESHOLD}); routing to ${resolvedAction}.`;
      addPolicyNote(note);
    }

    if (!candidates.length && resolvedAction === "elastic_only") {
      const summary = "No matching grocery items were found for this request.";
      const details = [
        ...(policyMeta.reason ? [policyMeta.reason] : []),
        "Try using different product keywords or simplify the description.",
        "Our catalog focuses on food, beverage, and household products.",
      ];
      logPolicyDecision({
        query: nlQuery,
        preferences,
        policyMeta,
        finalModel: "none",
      });
      return res.json({
        query: nlQuery,
        products: [],
        promotions: [],
        reasoning: {
          summary,
          details,
          origin: "heuristic",
        },
        meta: {
          agentCore: false,
          ...(agentCoreFallbackReason ? { agentCoreError: agentCoreFallbackReason } : {}),
          productTool: productResult.status,
          promotionTool: promoResult.status,
          rerankApplied: rerank,
          reasoningOrigin: "heuristic",
          preferenceFiltersApplied: preferenceResult.applied ? preferenceResult.tags : undefined,
          preferenceMatchedCount: preferenceResult.applied ? preferenceResult.matched : undefined,
          preferenceFilteredOut: preferenceResult.applied ? preferenceResult.filteredOut : undefined,
          preferences: preferences.dietaryTags.length ? preferences : undefined,
          policyDecision: policyMeta,
          policyMode,
        },
      });
    }
    let reasoningModel = "none";
    let reasoning;
    const advancedOrigins = new Set(["bedrock", "titan-express", "titan-premier"]);

    const resolvedForMeta = resolvedAction;
    policyMeta = {
      ...policyMeta,
      action: resolvedForMeta,
      resolvedAction: resolvedForMeta,
      originalAction,
    };

    switch (resolvedAction) {
      case "elastic_plus_titan_express": {
        reasoning = await reasonWithTitan(
          BEDROCK_TITAN_EXPRESS_MODEL_ID,
          queryForLLM,
          candidates,
          promotions,
          queryContext,
          "titan-express"
        );
        if (reasoning?.origin === "titan-express") {
          reasoningModel = "titan-express";
        } else if (!candidates.length) {
          reasoning = await reasonWithBedrock(queryForLLM, candidates, promotions, true, queryContext);
          if (reasoning?.origin === "bedrock") {
            reasoningModel = "bedrock";
            resolvedAction = "elastic_plus_sonnet";
            policyMeta = { ...policyMeta, resolvedAction };
          }
        }
        break;
      }
      case "elastic_plus_titan_premier": {
        reasoning = await reasonWithTitan(
          BEDROCK_TITAN_PREMIER_MODEL_ID,
          queryForLLM,
          candidates,
          promotions,
          queryContext,
          "titan-premier"
        );
        if (reasoning?.origin === "titan-premier") {
          reasoningModel = "titan-premier";
        } else if (!candidates.length) {
          reasoning = await reasonWithBedrock(queryForLLM, candidates, promotions, true, queryContext);
          if (reasoning?.origin === "bedrock") {
            reasoningModel = "bedrock";
            resolvedAction = "elastic_plus_sonnet";
            policyMeta = { ...policyMeta, resolvedAction };
          }
        }
        break;
      }
      case "elastic_plus_sonnet": {
        reasoning = await reasonWithBedrock(queryForLLM, candidates, promotions, true, queryContext);
        if (reasoning?.origin === "bedrock") reasoningModel = "bedrock";
        break;
      }
      default: {
        reasoning = await reasonWithBedrock(queryForLLM, candidates, promotions, false, queryContext);
        break;
      }
    }

    let products = candidates;
    const advancedRanking = Array.isArray(reasoning?.productRanking) ? reasoning.productRanking : [];
    let advancedRerankApplied = false;
    let advancedRankingMatches = 0;
    let advancedFallbackApplied = false;
    let contextualFallbackApplied = false;
    let budgetAdjustmentApplied = false;

    const candidateIdSet = new Set(
      candidates
        .map((product) => normaliseProductKey(getProductIdentifier(product)))
        .filter(Boolean)
    );
    const rankingHasKnownIds = Array.isArray(reasoning?.productRanking)
      ? reasoning.productRanking.some((entry) => {
          if (!entry || typeof entry !== "object") return false;
          const possibleId =
            entry.productId ||
            entry.product_id ||
            entry.id ||
            null;
          const key = normaliseProductKey(possibleId);
          return key ? candidateIdSet.has(key) : false;
        })
      : false;

    if (
      (reasoning?.origin === "titan-express" || reasoning?.origin === "titan-premier") &&
      (!rankingHasKnownIds || (!reasoning.summary && (!reasoning.details || !reasoning.details.length)))
    ) {
      const titanFallback = await reasonWithBedrock(nlQuery, candidates, promotions, true, queryContext);
      reasoning = titanFallback;
      if (reasoning?.origin === "bedrock") {
        reasoningModel = "bedrock";
        resolvedAction = "elastic_plus_sonnet";
        const fallbackNote = "Titan response was incomplete; routed to elastic_plus_sonnet.";
        policyMeta = {
          ...policyMeta,
          resolvedAction,
          reason: policyMeta.reason ? `${policyMeta.reason} ${fallbackNote}` : fallbackNote,
        };
      }
    }

    if (preferenceFallbackMessage) {
      const details = reasoning?.details ?? [];
      const merged = [...details, preferenceFallbackMessage];
      reasoning = {
        summary:
          reasoning?.summary ||
          "Showing best available matches after relaxing dietary filters.",
        details: merged.slice(0, 4),
        origin: reasoning?.origin ?? "heuristic",
        productRanking: reasoning?.productRanking,
      };
    }

    if (advancedOrigins.has(reasoning?.origin) && advancedRanking.length) {
      const reordered = applyBedrockRanking(candidates, advancedRanking);
      products = reordered.products;
      advancedRerankApplied = reordered.applied;
      advancedRankingMatches = reordered.matchedCount;
    } else if (advancedOrigins.has(reasoning?.origin) && !advancedRanking.length) {
      const fallback = applyContextualFallbackRanking(candidates, queryContext, nlQuery);
      products = fallback.products;
      advancedRerankApplied = fallback.applied;
      advancedFallbackApplied = fallback.applied;
    } else if (!advancedOrigins.has(reasoning?.origin) && queryContext.hasBudgetConstraint) {
      const fallback = applyContextualFallbackRanking(candidates, queryContext, nlQuery);
      if (fallback.applied) {
        products = fallback.products;
        contextualFallbackApplied = true;
      }
    }

    if (queryContext.hasBudgetConstraint) {
      const budgetAdjusted = enforceBudgetOrdering(products, queryContext);
      if (budgetAdjusted.applied) {
        products = budgetAdjusted.products;
        budgetAdjustmentApplied = true;
      }
    }

    products = products.slice(0, size);
    const budgetStats = summariseBudget(products, queryContext.maxPrice);

    if (!products.length) {
      const summary = reasoning?.summary ||
        "No matching products were found after applying filters.";
      const details = reasoning?.details && reasoning.details.length
        ? reasoning.details
        : [
            ...(policyMeta.reason ? [policyMeta.reason] : []),
            "Try adjusting dietary filters or keywords to broaden the search.",
            "Our catalogue focuses on grocery and household items.",
          ];
      logPolicyDecision({
        query: nlQuery,
        preferences,
        policyMeta,
        finalModel: "none",
      });
      return res.json({
        query: nlQuery,
        products: [],
        promotions: [],
        reasoning: {
          summary,
          details,
          origin: reasoning?.origin ?? "heuristic",
        },
        meta: {
          agentCore: false,
          ...(agentCoreFallbackReason ? { agentCoreError: agentCoreFallbackReason } : {}),
          productTool: productResult.status,
          promotionTool: promoResult.status,
          rerankApplied: rerank,
          reasoningOrigin: reasoning?.origin ?? "heuristic",
          preferenceFiltersApplied: preferenceResult.applied ? preferenceResult.tags : undefined,
          preferenceMatchedCount: preferenceResult.applied ? preferenceResult.matched : undefined,
          preferenceFilteredOut: preferenceResult.applied ? preferenceResult.filteredOut : undefined,
          preferences: preferences.dietaryTags.length ? preferences : undefined,
          policyDecision: policyMeta,
          policyMode,
        },
      });
    }

    res.json({
      query: nlQuery,
      products,
      promotions,
      reasoning,
      meta: {
        agentCore: false,
        ...(agentCoreFallbackReason ? { agentCoreError: agentCoreFallbackReason } : {}),
        productTool: productResult.status,
        promotionTool: promoResult.status,
        rerankApplied: rerank,
        reasoningOrigin: reasoning?.origin ?? "heuristic",
        advancedCandidateCount: usesAdvancedModel ? candidates.length : undefined,
        advancedRankingCount: advancedRanking.length || undefined,
        advancedRankingMatches: advancedRankingMatches || undefined,
        advancedRerankApplied: advancedRerankApplied || undefined,
        advancedFallbackApplied: advancedFallbackApplied || undefined,
        contextualFallbackApplied: contextualFallbackApplied || undefined,
        budgetAdjustmentApplied: budgetAdjustmentApplied || undefined,
        budgetMaxPrice: queryContext.maxPrice || undefined,
        budgetWithinCount:
          typeof budgetStats.within === "number" ? budgetStats.within : undefined,
        budgetOverCount: typeof budgetStats.over === "number" ? budgetStats.over : undefined,
        budgetAveragePrice:
          typeof budgetStats.averagePrice === "number" ? budgetStats.averagePrice : undefined,
        preferenceFiltersApplied: preferenceResult.applied ? preferenceResult.tags : undefined,
        preferenceFilteredOut:
          preferenceResult.applied && preferenceResult.filteredOut
            ? preferenceResult.filteredOut
            : undefined,
        preferenceMatchedCount:
          preferenceResult.applied ? preferenceResult.matched : undefined,
        preferenceFallback: preferenceFallbackApplied || undefined,
        preferences: preferences.dietaryTags.length ? preferences : undefined,
        policyDecision: policyMeta,
        policyMode,
        reasoningModel,
      },
    });
    let finalModelState = reasoningModel;
    if (finalModelState === "bedrock") finalModelState = "sonnet";
    logPolicyDecision({
      query: nlQuery,
      preferences,
      policyMeta,
      finalModel: finalModelState,
    });
  } catch (error) {
    console.error("Assistant error", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/mcp/tool", async (req, res) => {
  const { name, args = {} } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }
  try {
    const result = await callTool(name, args);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Healthy Basket MCP proxy listening on http://localhost:${PORT}`);
});

function normaliseProductKey(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed.toLowerCase() : null;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function getProductIdentifier(product) {
  if (!product || typeof product !== "object") return null;
  return (
    product.product_id ??
    product.productId ??
    product.sku ??
    product.id ??
    null
  );
}

function applyBedrockRanking(products, rankingEntries) {
  // Merge Bedrock-provided ranking (if any) with the locally ranked product list.
  if (!Array.isArray(products) || !products.length) {
    return { products, applied: false, matchedCount: 0 };
  }

  const idLookup = new Map();
  const nameLookup = new Map();

  products.forEach((product, index) => {
    const idKey = normaliseProductKey(getProductIdentifier(product));
    if (idKey && !idLookup.has(idKey)) {
      idLookup.set(idKey, index);
    }
    const nameKey = normaliseProductKey(product?.name);
    if (nameKey) {
      const bucket = nameLookup.get(nameKey) || [];
      bucket.push(index);
      nameLookup.set(nameKey, bucket);
    }
  });

  const usedIndices = new Set();
  const rankMap = new Map();

  rankingEntries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;

    let matchIndex = null;
    if (entry.productId) {
      const idKey = normaliseProductKey(entry.productId);
      if (idKey && idLookup.has(idKey)) {
        matchIndex = idLookup.get(idKey);
      }
    }

    if (matchIndex === null && entry.name) {
      const nameKey = normaliseProductKey(entry.name);
      if (nameKey && nameLookup.has(nameKey)) {
        const candidates = nameLookup.get(nameKey);
        const candidate = candidates.find((candidateIndex) => !usedIndices.has(candidateIndex));
        if (candidate !== undefined) {
          matchIndex = candidate;
        }
      }
    }

    if (matchIndex === null || usedIndices.has(matchIndex)) {
      return;
    }

    usedIndices.add(matchIndex);

    const rawScore = entry.score;
    let score =
      typeof rawScore === "number"
        ? rawScore
        : typeof rawScore === "string"
        ? Number(rawScore)
        : null;
    if (typeof score === "number" && Number.isFinite(score)) {
      score = Math.max(0, Math.min(1, score));
    } else {
      score = null;
    }

    rankMap.set(matchIndex, {
      position: index,
      score,
    });
  });

  if (!rankMap.size) {
    return { products, applied: false, matchedCount: 0 };
  }

  const annotated = products.map((product, index) => {
    const rankInfo = rankMap.get(index);
    return {
      product,
      originalIndex: index,
      rank: rankInfo ? rankInfo.position : Number.POSITIVE_INFINITY,
      score: rankInfo ? rankInfo.score : null,
      matched: Boolean(rankInfo),
    };
  });

  const matchedCount = annotated.filter((entry) => entry.matched).length;
  if (!matchedCount) {
    return { products, applied: false, matchedCount: 0 };
  }

  const sorted = [...annotated].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const aHasScore = a.score !== null;
    const bHasScore = b.score !== null;
    if (aHasScore && bHasScore && a.score !== b.score) {
      return b.score - a.score;
    }
    if (aHasScore && !bHasScore) return -1;
    if (!aHasScore && bHasScore) return 1;
    return a.originalIndex - b.originalIndex;
  });

  const reorderedProducts = sorted.map((entry) => entry.product);
  const applied = reorderedProducts.some((product, idx) => product !== products[idx]);

  return {
    products: reorderedProducts,
    applied,
    matchedCount,
  };
}

function applyContextualFallbackRanking(products, queryContext, query) {
  if (!Array.isArray(products) || !products.length) {
    return { products, applied: false };
  }
  const context = queryContext || analyseQueryContext(query);
  const tokens = (context?.tokens || []).filter((token) => token.length > 2);

  const annotated = products.map((product, index) => {
    const baseScore = scoreProduct(query, product);
    const form = classifyProductForm(product);
    const name = (product?.name || "").toLowerCase();
    const description = (product?.description || "").toLowerCase();
    const labels = Array.isArray(product?.labels) ? product.labels : [];
    const category = (product?.category || "").toLowerCase();
    const subcategory = (product?.subcategory || "").toLowerCase();

    let matchScore = 0;
    tokens.forEach((token) => {
      if (name.includes(token)) matchScore += 10;
      if (description.includes(token)) matchScore += 4;
      if (category.includes(token) || subcategory.includes(token)) matchScore += 6;
      if (
        labels.some(
          (label) => typeof label === "string" && label.toLowerCase().includes(token)
        )
      ) {
        matchScore += 3;
      }
    });

    let formBoost = 0;
    if (context?.mentionsSauce) {
      if (form === "prepared_sauce") formBoost += 18;
      if (form === "whole_produce") formBoost -= 10;
    } else {
      if (form === "whole_produce") formBoost += 22;
      if (form === "prepared_sauce") formBoost -= 16;
    }
    if (context?.mentionsFresh && form === "whole_produce") {
      formBoost += 8;
    }

    const promotionBoost =
      Array.isArray(product?.promotionIds) && product.promotionIds.length
        ? 2
        : 0;

    const price = typeof product?.price === "number" ? product.price : null;
    let budgetBoost = 0;
    if (context?.maxPrice !== null && context?.maxPrice !== undefined && typeof price === "number") {
      if (price <= context.maxPrice) {
        budgetBoost += 35;
      } else {
        const overage = price - context.maxPrice;
        budgetBoost -= 25 + Math.min(20, overage * 8);
      }
    }

    const adjustedScore = baseScore + matchScore + formBoost + promotionBoost + budgetBoost;
    return {
      product,
      originalIndex: index,
      adjustedScore,
    };
  });

  const sorted = [...annotated].sort((a, b) => {
    if (b.adjustedScore !== a.adjustedScore) return b.adjustedScore - a.adjustedScore;
    return a.originalIndex - b.originalIndex;
  });

  const reorderedProducts = sorted.map((entry) => entry.product);
  const applied = reorderedProducts.some((product, idx) => product !== products[idx]);

  return {
    products: reorderedProducts,
    applied,
  };
}

function applyPreferenceFilters(products, preferences) {
  const tags = Array.isArray(preferences?.dietaryTags) ? preferences.dietaryTags : [];
  const uniqueTags = Array.from(
    new Set(tags.map((tag) => String(tag).toLowerCase().replace(/[\s-]+/g, "_")))
  );
  if (!uniqueTags.length) {
    return {
      filtered: products,
      applied: false,
      tags: [],
      matched: products.length,
      filteredOut: 0,
    };
  }
  const filtered = products.filter((product) => {
    const rawTags = [];
    if (Array.isArray(product?.dietary_tags)) rawTags.push(...product.dietary_tags);
    if (Array.isArray(product?.labels)) rawTags.push(...product.labels);
    const normalisedProductTags = new Set(
      rawTags
        .filter((tag) => typeof tag === "string")
        .map((tag) => tag.toLowerCase().replace(/[\s-]+/g, "_"))
    );
    return uniqueTags.every((tag) => normalisedProductTags.has(tag));
  });
  return {
    filtered,
    applied: true,
    tags: uniqueTags,
    matched: filtered.length,
    filteredOut: Math.max(0, products.length - filtered.length),
  };
}

function enforceBudgetOrdering(products, queryContext) {
  if (!Array.isArray(products) || !products.length) {
    return { products, applied: false };
  }
  const maxPrice = queryContext?.maxPrice;
  if (maxPrice === null || maxPrice === undefined) {
    return { products, applied: false };
  }
  const withinBudget = [];
  const overBudget = [];
  products.forEach((product) => {
    const price = typeof product?.price === "number" ? product.price : null;
    if (price !== null && price <= maxPrice) {
      withinBudget.push(product);
    } else {
      overBudget.push(product);
    }
  });
  if (!withinBudget.length) {
    return { products, applied: false };
  }
  const combined = withinBudget.concat(overBudget);
  const applied = combined.some((product, index) => product !== products[index]);
  return {
    products: combined,
    applied,
  };
}

function summariseBudget(products, maxPrice) {
  if (maxPrice === null || maxPrice === undefined) {
    return {
      within: null,
      over: null,
      averagePrice: null,
    };
  }
  let within = 0;
  let over = 0;
  let sum = 0;
  let count = 0;
  products.forEach((product) => {
    const price = typeof product?.price === "number" ? product.price : null;
    if (price === null) return;
    sum += price;
    count += 1;
    if (price <= maxPrice) {
      within += 1;
    } else {
      over += 1;
    }
  });
  return {
    within,
    over,
    averagePrice: count ? sum / count : null,
  };
}

function scoreProduct(nlQuery, product) {
  if (!product) return -Infinity;
  const text = nlQuery.toLowerCase();
  const tokens = new Set(text.split(/\W+/).filter(Boolean));

  let score = 0;

  const name = (product.name || "").toLowerCase();
  tokens.forEach((token) => {
    if (name.includes(token)) score += 6;
  });

  const keywordField = [
    product.keyword,
    ...(product.search_keywords || []),
    product.category,
    product.subcategory,
    product.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  tokens.forEach((token) => {
    if (keywordField.includes(token)) score += 3;
  });

  if (product.category === "Fruit & Vegetables" && /tomat/i.test(text)) {
    score += 4;
  }

  const health = product.healthScore ?? product.nutrition?.health_score;
  if (typeof health === "number") {
    score += health / 25;
  }

  const savings =
    typeof product.regularPrice === "number" && typeof product.price === "number"
      ? (product.regularPrice - product.price) / Math.max(product.regularPrice, 1)
      : 0;
  score += savings * 5;

  const labels = Array.isArray(product.labels)
    ? product.labels
    : product.labels
    ? [product.labels]
    : [];
  if (labels.some((tag) => typeof tag === "string" && /fresh|seasonal|organic/i.test(tag))) {
    score += 1;
  }

  return score;
}

function rerankProducts(nlQuery, products) {
  return [...products]
    .map((product) => ({
      product,
      score: scoreProduct(nlQuery, product),
    }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.product);
}
