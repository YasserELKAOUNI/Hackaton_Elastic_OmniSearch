const AWS = require("aws-sdk");

const client = new AWS.BedrockRuntime({
  region: process.env.BEDROCK_REGION
});

exports.handler = async (event = {}) => {
  const query = event.query;
  if (!query || typeof query !== "string") {
    throw new Error("Missing 'query' string for haikuPolicy.");
  }

  const systemPrompt = process.env.HAIKU_SYSTEM_PROMPT;
  const modelId = process.env.HAIKU_MODEL_ID;
  if (!modelId || !systemPrompt) {
    throw new Error("HAIKU_MODEL_ID and HAIKU_SYSTEM_PROMPT must be configured.");
  }

  let metrics = {};
  if (typeof event.metricsJson === "string") {
    try {
      metrics = JSON.parse(event.metricsJson);
    } catch (_) {}
  }

  const policyMode = event.policyMode || metrics.policyMode || "semi_managed";
  const forceSonnet = event.forceSonnet ?? metrics.forceSonnet ?? false;
  const coreTokenCount = metrics.coreTokenCount ?? event.coreTokenCount ?? 0;
  const dietaryTagCount = metrics.dietaryTagCount ?? event.dietaryTagCount ?? 0;
  const hasBudgetConstraint =
    metrics.hasBudgetConstraint ?? event.hasBudgetConstraint ?? false;
  const complexityScoreHint =
    metrics.complexityScoreHint ?? event.complexityScoreHint ?? null;

  let availability = {};
  if (typeof event.availabilityJson === "string") {
    try {
      availability = JSON.parse(event.availabilityJson);
    } catch (_) {}
  }

  const availableModels = {
    sonnet: availability.sonnet ?? availability.sonnetAvailable ?? event.sonnetAvailable ?? false,
    titanExpress:
      availability.titanExpress ?? availability.titanExpressAvailable ?? event.titanExpressAvailable ?? false,
    titanPremier:
      availability.titanPremier ?? availability.titanPremierAvailable ?? event.titanPremierAvailable ?? false
  };

  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 128,
    temperature: 0,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              query,
              metrics: {
                coreTokenCount,
                dietaryTagCount,
                hasBudgetConstraint,
                forceSonnet,
                policyMode,
                complexityScoreHint
              },
              availableModels
            })
          }
        ]
      }
    ]
  };

  const response = await client
    .invokeModel({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload)
    })
    .promise();

  const body = JSON.parse(response.body.toString());
  const text =
    (body.content && body.content[0] && body.content[0].text) ||
    body.completion ||
    "{}";
  const parsed = JSON.parse(text);

  return {
    action: parsed.action,
    complexityScore: parsed.complexity ?? parsed.complexity_score ?? null,
    reason: parsed.notes ?? parsed.reason ?? null,
    raw: parsed
  };
};
