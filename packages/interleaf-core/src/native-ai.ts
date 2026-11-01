import type { AICapability, ReasoningEffort } from "./index";

export type AIModelRole = "chat" | "translation" | "vision" | "research";
export interface NativeAIConfig {
  version: 2;
  connection: {
    protocol: "openai" | "anthropic";
    url: string;
    hasKey: boolean;
  };
  models: Partial<Record<AIModelRole, string>>;
  efforts: Partial<Record<AIModelRole, ReasoningEffort>>;
  apiModels: string[];
  translationPrompt?: string;
  needsConfiguration?: string;
}
export interface NativeAIConfigUpdate {
  version: 2;
  connection: {
    protocol: "openai" | "anthropic";
    url: string;
    key?: string | null;
  };
  models?: Partial<Record<AIModelRole, string>>;
  efforts?: Partial<Record<AIModelRole, ReasoningEffort>>;
  apiModels?: string[];
  translationPrompt?: string;
}
export interface NativeAICheck extends AICapability {
  model: string;
  fingerprint: string;
}

/** Public snapshots contain only a key marker. Never send that marker as an edit. */
export function nativeConfigUpdate(
  config: NativeAIConfig,
): NativeAIConfigUpdate {
  return {
    version: 2,
    connection: {
      protocol: config.connection.protocol,
      url: config.connection.url,
    },
    models: { ...config.models },
    efforts: { ...config.efforts },
    apiModels: [...config.apiModels],
    ...(config.translationPrompt !== undefined
      ? { translationPrompt: config.translationPrompt }
      : {}),
  };
}
