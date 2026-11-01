import type { NativeAIConfig } from "@interleaf/core";

type Connection = Pick<NativeAIConfig["connection"], "url" | "protocol">;

export const providerPresets = [
  { id: "deepseek", label: "DeepSeek", url: "https://api.deepseek.com/v1" },
  {
    id: "bailian",
    label: "阿里百炼",
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  { id: "kimi", label: "Kimi", url: "https://api.moonshot.cn/v1" },
  { id: "zhipu", label: "智谱", url: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "minimax", label: "MiniMax", url: "https://api.minimax.cn/v1" },
] as const;

export type ProviderPreset = (typeof providerPresets)[number]["id"] | "custom";

export function connectionURL(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    const parts = trimmed.match(/^([a-z][a-z\d+.-]*:)\/\/([^/?#]+)(.*)$/i);
    if (!parts || parts[2].includes("\\")) return trimmed;
    const credentials = parsed.username
      ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`
      : "";
    // Match the server's origin normalization without rewriting custom paths.
    return `${parsed.protocol}//${credentials}${parsed.host}${parts[3]}`;
  } catch {
    return trimmed;
  }
}

export function sameConnection(left: Connection, right: Connection): boolean {
  return (
    left.protocol === right.protocol &&
    connectionURL(left.url) === connectionURL(right.url)
  );
}

export function inferProvider(connection?: Connection): ProviderPreset {
  if (!connection || connection.protocol !== "openai") return "custom";
  try {
    const parsed = new URL(connection.url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      return "custom";
    const url = connectionURL(connection.url);
    if (url === "https://api.deepseek.com") return "deepseek";
    return providerPresets.find((preset) => url === preset.url)?.id ?? "custom";
  } catch {
    return "custom";
  }
}
