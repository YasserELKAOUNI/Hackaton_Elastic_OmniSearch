const AWS = require("aws-sdk");

const bedrock = new AWS.BedrockRuntime({ region: process.env.BEDROCK_REGION });

exports.handler = async (event = {}) => {
  const { query, products = [], budgetMaxPrice, dietaryTags = [] } = event;

  if (!query || typeof query !== "string") {
    throw new Error("Missing 'query' string.");
  }

  const modelId = process.env.TITAN_EXPRESS_MODEL_ID;
  if (!modelId) {
    throw new Error("TITAN_EXPRESS_MODEL_ID environment variable must be set.");
  }

  const payload = {
    inputText: JSON.stringify({
      query,
      products,
      budgetMaxPrice,
      dietaryTags
    }),
    textGenerationConfig: {
      maxTokenCount: 640,
      temperature: 0.2,
      topP: 0.9
    }
  };

  const response = await bedrock
    .invokeModel({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload),
      inferenceProfile: process.env.TITAN_EXPRESS_PROFILE_ARN || undefined
    })
    .promise();

  const body = JSON.parse(response.body.toString());
  return body;
};
