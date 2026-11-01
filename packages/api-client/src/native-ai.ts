import type {
  AIModelRole,
  AgentModel,
  NativeAIConfig,
  NativeAIConfigUpdate,
  NativeAICheck,
} from "@interleaf/core";
import { request } from "./transport";

export const nativeAI = {
  nativeAIConfig: () => request<NativeAIConfig>("/api/ai/config"),
  saveNativeAIConfig: (config: NativeAIConfigUpdate) =>
    request<NativeAIConfig>("/api/ai/config", {
      method: "PUT",
      body: JSON.stringify(config),
    }),
  nativeAIModels: (role: AIModelRole, signal?: AbortSignal, refresh = false) =>
    request<AgentModel[]>(
      `/api/ai/models?role=${encodeURIComponent(role)}${refresh ? "&refresh=1" : ""}`,
      {
        signal,
      },
    ),
  checkNativeAI: (role: AIModelRole, model?: string, waitSeconds?: number) =>
    request<NativeAICheck>("/api/ai/check", {
      method: "POST",
      body: JSON.stringify({ role, model, waitSeconds }),
    }),
};
export const { nativeAIConfig, saveNativeAIConfig } = nativeAI;
