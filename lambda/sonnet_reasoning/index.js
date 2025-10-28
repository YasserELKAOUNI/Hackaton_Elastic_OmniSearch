const AWS = require("aws-sdk");

const bedrock = new AWS.BedrockRuntime({ region: process.env.BEDROCK_REGION });

exports.handler = async (event = {}) => {
  const { query, products = [], promotions = [], budgetMaxPrice, dietaryTags = [] } = event;

  if (!query || typeof query !== "string") {
    throw new Error("Missing 'query' string.");
  }

  const modelId = process.env.SONNET_MODEL_ID;
  if (!modelId) throw new Error("SONNET_MODEL_ID must be set.");

  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 512,
    temperature: 0.4,
    system: process.env.SONNET_SYSTEM_PROMPT || "You are Healthy Basket reasoning assistant.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              query,
              products,
              promotions,
              budgetMaxPrice,
              dietaryTags
            })
          }
        ]
      }
    ]
  };

  const response = await bedrock
    .invokeModel({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload)
    })
    .promise();

  const body = JSON.parse(response.body.toString());
  const text = (body.content && body.content[0] && body.content[0].text) || body.completion || "{}";
  return JSON.parse(text);
};
