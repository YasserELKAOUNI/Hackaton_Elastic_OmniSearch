const AWS = require("aws-sdk");
const bedrock = new AWS.BedrockRuntime({ region: process.env.BEDROCK_REGION });

function parseJson(str, fallback) {
  if (typeof str === "string") {
    try { return JSON.parse(str); } catch (_) { return fallback; }
  }
  return fallback;
}

exports.handler = async (event = {}) => {
  const query = event.query;
  if (!query || typeof query !== "string") throw new Error("Missing 'query'.");

  const products = parseJson(event.productsJson, []);
  const budgetMaxPrice = event.budgetMaxPrice ?? null;
  const dietaryTags = parseJson(event.dietaryTagsJson, []);

  const inferenceProfile = process.env.NOVA_PREMIER_PROFILE_ARN;
  if (!inferenceProfile) throw new Error("NOVA_PREMIER_PROFILE_ARN must be set.");

  const body = {
    inputText: JSON.stringify({
      query,
      products,
      budgetMaxPrice,
      dietaryTags
    }),
    textGenerationConfig: {
      maxTokenCount: 1024,
      temperature: 0.4,
      topP: 0.9
    }
  };

  const response = await bedrock.invokeModel({
    inferenceProfile,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(body)
  }).promise();

  return JSON.parse(response.body.toString());
};
