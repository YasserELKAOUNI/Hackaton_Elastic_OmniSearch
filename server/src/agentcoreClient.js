import crypto from "crypto";
import { BedrockAgentRuntimeClient, InvokeAgentCommand } from "@aws-sdk/client-bedrock-agent-runtime";

const rawEnabled = process.env.AGENTCORE_ENABLED;
const enabled =
  typeof rawEnabled === "string"
    ? ["1", "true", "yes", "on"].includes(rawEnabled.trim().toLowerCase())
    : false;

const agentId = process.env.AGENTCORE_AGENT_ID;
const agentAliasId = process.env.AGENTCORE_AGENT_ALIAS_ID;
const region = process.env.AGENTCORE_REGION || process.env.BEDROCK_REGION;
const defaultPolicyMode = process.env.AGENTCORE_DEFAULT_POLICY_MODE || "fully_managed";

const agentConfigured = Boolean(enabled && agentId && agentAliasId && region);

let agentClient = null;

if (agentConfigured) {
  agentClient = new BedrockAgentRuntimeClient({ region });
} else if (enabled) {
  console.warn(
    "⚠️ AgentCore is enabled but AGENTCORE_AGENT_ID / AGENTCORE_AGENT_ALIAS_ID / AGENTCORE_REGION are not fully configured. Falling back to legacy routing."
  );
}

const textDecoder = new TextDecoder();

function extractJsonPayload(content) {
  if (!content) return null;
  if (typeof content === "object") return content;
  if (typeof content !== "string") return null;
  try {
    return JSON.parse(content);
  } catch (error) {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(content.slice(start, end + 1));
      } catch (innerError) {
        return null;
      }
    }
    return null;
  }
}

export function isAgentCoreReady() {
  return Boolean(agentClient);
}

export function getAgentCoreConfig() {
  return {
    enabled,
    agentId,
    agentAliasId,
    region,
    defaultPolicyMode,
    ready: isAgentCoreReady(),
  };
}

export async function invokeAgentCore({
  query,
  preferences,
  size,
  policyMode,
  useBedrock,
  rerank,
}) {
  if (!agentClient) {
    throw new Error("AgentCore client is not configured.");
  }

  const sessionId = `hb-${crypto.randomUUID()}`;
  const envelope = {
    query,
    preferences,
    size,
    policyMode: policyMode || defaultPolicyMode,
    userToggles: {
      forceSonnet: Boolean(useBedrock),
    },
    rerank: Boolean(rerank),
    timestamp: new Date().toISOString(),
  };

  const command = new InvokeAgentCommand({
    agentId,
    agentAliasId,
    sessionId,
    inputText: JSON.stringify(envelope),
  });

  const response = await agentClient.send(command);

  let rawText = "";

  if (response?.completion) {
    for await (const event of response.completion) {
      if (event?.chunk?.bytes) {
        rawText += textDecoder.decode(event.chunk.bytes, { stream: true });
      } else if (event?.message?.content) {
        for (const part of event.message.content) {
          if (typeof part?.text === "string") {
            rawText += part.text;
          }
        }
      }
    }
  }

  const payload =
    extractJsonPayload(response?.outputText) ||
    extractJsonPayload(rawText);

  if (!payload || typeof payload !== "object") {
    const snippet = rawText ? rawText.slice(0, 300) : "<no-agent-response>";
    throw new Error(`AgentCore returned an unexpected payload: ${snippet}`);
  }

  const products = Array.isArray(payload.products) ? payload.products : [];
  const promotions = Array.isArray(payload.promotions) ? payload.promotions : [];
  const reasoning =
    payload.reasoning && typeof payload.reasoning === "object"
      ? {
          ...payload.reasoning,
          origin: payload.reasoning.origin || "agentcore",
        }
      : undefined;

  const overridableMeta =
    payload.meta && typeof payload.meta === "object"
      ? payload.meta
      : {};

  const finalMeta = {
    ...overridableMeta,
    agentCore: true,
    agentCoreAgentId: agentId,
    agentCoreAliasId: agentAliasId,
    agentCoreRegion: region,
    agentCoreSessionId: response?.sessionId || sessionId,
    rawAgentAnswer: rawText || JSON.stringify(payload),
  };

  if (!finalMeta.policyMode && payload.policyMode) {
    finalMeta.policyMode = payload.policyMode;
  }
  if (!finalMeta.policyDecision && payload.policyDecision) {
    finalMeta.policyDecision = payload.policyDecision;
  }
  if (!finalMeta.resolvedAction && payload.resolvedAction) {
    finalMeta.resolvedAction = payload.resolvedAction;
  }
  if (!finalMeta.complexityScore && payload.complexityScore !== undefined) {
    finalMeta.complexityScore = payload.complexityScore;
  }
  if (payload.action && !finalMeta.action) {
    finalMeta.action = payload.action;
  }

  return {
    query,
    products,
    promotions,
    reasoning,
    meta: finalMeta,
  };
}
