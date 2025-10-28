const DEFAULT_SIZE = 20;

/**
 * Lambda entry point for the AgentCore elasticSearchTopN action group.
 * Expects an event shaped like:
 * {
 *   "query": "healthy breakfast",
 *   "size": 20,
 *   "preferences": { "dietaryTags": ["vegan"] }
 * }
 *
 * The Lambda simply forwards the call to the Healthy Basket MCP proxy so we reuse
 * the existing Elastic integration. All configuration (URL/API key) is provided
 * through environment variables.
 */
export const handler = async (event = {}) => {
  const {
    query,
    size = DEFAULT_SIZE,
    preferences,
    dietaryTags,
  } = event;

  if (!query || typeof query !== "string" || !query.trim()) {
    throw new Error("Missing required 'query' field for elasticSearchTopN.");
  }

  const mcpUrl = process.env.MCP_URL;
  const mcpApiKey = process.env.MCP_API_KEY;
  const productTool = process.env.MCP_PRODUCT_TOOL || "healthy_basket_products";

  if (!mcpUrl || !mcpApiKey) {
    throw new Error("MCP_URL and MCP_API_KEY environment variables must be configured.");
  }

  const endpoint = `${mcpUrl.replace(/\/+$/, "")}/invoke`;
  let normalisedPreferences =
    preferences && typeof preferences === "object" ? { ...preferences } : {};
  if (Array.isArray(dietaryTags)) {
    normalisedPreferences.dietaryTags = dietaryTags;
  } else if (typeof dietaryTags === "string" && dietaryTags.trim().length) {
    normalisedPreferences.dietaryTags = dietaryTags
      .split(/[,;]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(normalisedPreferences.dietaryTags)) {
    normalisedPreferences.dietaryTags = [];
  }

  const payload = {
    name: productTool,
    arguments: {
      query,
      size,
      preferences: normalisedPreferences,
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `ApiKey ${mcpApiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Elastic search tool invocation failed: ${response.status} ${text}`);
  }

  const raw = await response.json();
  const products = Array.isArray(raw?.content?.items) ? raw.content.items : raw?.products ?? [];

  return {
    products,
    meta: {
      size,
      query,
      dietaryTags: preferences?.dietaryTags ?? [],
    },
  };
};
