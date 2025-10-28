import { useRef, useState } from "react";
import { AssistantPayload, AssistantResponse, PolicyMode, UserPreferences } from "../lib/types";

export type ConversationEntry = {
  id: string;
  query: string;
  summary?: string;
  timestamp: number;
};

export function useAssistant() {
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [data, setData] = useState<AssistantResponse | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const trigger = async (
    nlQuery: string,
    options?: {
      rerank?: boolean;
      useBedrock?: boolean;
      size?: number;
      preferences?: UserPreferences;
      policyMode?: PolicyMode;
      useAgentCore?: boolean;
    }
  ) => {
    const payload: AssistantPayload = { nlQuery };
    if (options?.rerank) payload.rerank = true;
    if (options?.useBedrock !== undefined) payload.useBedrock = options.useBedrock;
    if (options?.size) payload.size = options.size;
    if (options?.preferences) payload.preferences = options.preferences;
    if (options?.policyMode) payload.policyMode = options.policyMode;
    if (options?.useAgentCore !== undefined) payload.useAgentCore = options.useAgentCore;

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    const currentRequestId = requestIdRef.current + 1;
    requestIdRef.current = currentRequestId;

    setIsLoading(true);
    setError(undefined);
    setData(undefined);

    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Assistant request failed");
      }

      const result = (await response.json()) as AssistantResponse;

      if (requestIdRef.current !== currentRequestId) {
        return undefined;
      }

      setData(result);
      setConversation((prev) => [
        {
          id: crypto.randomUUID(),
          query: nlQuery,
          summary: result.reasoning?.summary,
          timestamp: Date.now(),
        },
        ...prev,
      ]);
      return result;
    } catch (err) {
      if (requestIdRef.current !== currentRequestId) {
        return undefined;
      }
      if ((err as Error).name === "AbortError") {
        return undefined;
      }
      setError(err as Error);
      setData(undefined);
      return undefined;
    } finally {
      if (requestIdRef.current === currentRequestId) {
        setIsLoading(false);
      }
    }
  };

  return {
    data,
    trigger,
    isLoading,
    isError: error,
    conversation,
    mutateConversation: setConversation,
  };
}
