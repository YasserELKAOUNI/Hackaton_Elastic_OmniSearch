import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION });

export const handler = async (event = {}) => {
  const {
    query,
    coreTokenCount = 0,
    dietaryTagCount = 0,
    hasBudgetConstraint = false,
    forceSonnet = false,
    policyMode = "semi_managed",
    complexityScoreHint,
    availableModels = {}
  } = event;

  if (!query || typeof query !== "string") {
    throw new Error("Missing 'query' string for haikuPolicy.");
  }

  const systemPrompt = process.env.HAIKU_SYSTEM_PROMPT;
  const modelId = process.env.HAIKU_MODEL_ID;

  if (!modelId || !systemPrompt) {
    throw new Error("HAIKU_MODEL_ID and HAIKU_SYSTEM_PROMPT must be configured.");
  }

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

  const response = await client.send(
    new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload)
    })
  );

  const body = JSON.parse(new TextDecoder().decode(response.body));
  const text = body?.content?.[0]?.text ?? body?.completion ?? "{}";
  const parsed = JSON.parse(text);

  return {
    action: parsed.action,
    complexityScore: parsed.complexity ?? parsed.complexity_score ?? null,
    reason: parsed.notes ?? parsed.reason ?? null,
    raw: parsed
  };
};
