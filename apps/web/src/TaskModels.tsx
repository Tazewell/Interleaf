import { useEffect, useId, useRef, useState } from "react";
import { api } from "@interleaf/api";
import {
  nativeConfigUpdate,
  type NativeAIConfig,
  type AIModelRole,
  type AgentModel,
  type NativeAICheck,
  type ReasoningEffort,
} from "@interleaf/core";
import { Input } from "@interleaf/ui/components/input";
import { Button } from "@interleaf/ui/components/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@interleaf/ui/components/select";
import { toast } from "sonner";
import {
  catalogRevision,
  effortLabel,
  efforts,
  selectedAgentModel,
} from "./ModelSelector";
import { useReaderStore } from "./store";

const roles: [AIModelRole, string, string][] = [
  ["chat", "问答", "自动选择推荐模型"],
  ["translation", "翻译", "自动选择快速模型"],
  ["vision", "图片", "仅使用已验证支持图片的问答模型"],
  ["research", "研究", "继承问答模型"],
];
export function taskChoice(config: NativeAIConfig, role: AIModelRole) {
  return {
    model: config.models[role] ?? "",
    effort:
      config.efforts[role] ??
      (role === "research" && !config.models.research
        ? config.efforts.chat
        : undefined) ??
      "medium",
  };
}
export function TaskModels({ disabled }: { disabled: boolean }) {
  const {
    aiConfig: config,
    aiCatalogRevision,
    aiCatalogResult,
    invalidateAICatalog,
    setAIConfig,
    aiModelSaving: saving,
    setAIModelSaving,
  } = useReaderStore();
  const id = useId();
  const [catalog, setCatalog] = useState<AgentModel[]>([]);
  const [error, setError] = useState("");
  const [modelEdits, setModelEdits] = useState<
    Partial<Record<AIModelRole, string>>
  >({});
  const [effortEdits, setEffortEdits] = useState<
    Partial<Record<AIModelRole, ReasoningEffort>>
  >({});
  const [checking, setChecking] = useState<AIModelRole | null>(null);
  const [checks, setChecks] = useState<
    Partial<Record<AIModelRole, NativeAICheck>>
  >({});
  const [wait, setWait] = useState("15");
  const catalogRequest = useRef<AbortController | null>(null);
  const revision = `${catalogRevision(config)}\n${aiCatalogRevision}`;
  useEffect(() => {
    setModelEdits({});
    setEffortEdits({});
    setChecks({});
  }, [config]);
  useEffect(() => {
    setCatalog([]);
    setError("");
    if (!config?.connection.url || config.needsConfiguration) return;
    if (
      aiCatalogResult?.revision === aiCatalogRevision &&
      aiCatalogResult.config === config
    ) {
      setCatalog(aiCatalogResult.models);
      setError(
        aiCatalogResult.error
          ? `模型列表获取失败：${aiCatalogResult.error}。请刷新后重新选择。`
          : "",
      );
      return () => catalogRequest.current?.abort();
    }
    const controller = new AbortController();
    catalogRequest.current = controller;
    void api
      .agentModels("chat", controller.signal)
      .then((models) => {
        if (!controller.signal.aborted) setCatalog(models);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(`模型列表获取失败：${error.message}。请刷新后重新选择。`);
      });
    return () => catalogRequest.current?.abort();
  }, [revision, config, aiCatalogResult, aiCatalogRevision]);
  if (!config) return null;
  const refresh = async () => {
    catalogRequest.current?.abort();
    const controller = new AbortController();
    catalogRequest.current = controller;
    setCatalog([]);
    setError("");
    try {
      const models = await api.agentModels("chat", controller.signal, true);
      if (!controller.signal.aborted)
        invalidateAICatalog(config, { models, error: "" });
    } catch (error) {
      if (!controller.signal.aborted)
        invalidateAICatalog(config, {
          models: [],
          error: (error as Error).message,
        });
    }
  };
  const save = async () => {
    if (useReaderStore.getState().aiModelSaving) return;
    setAIModelSaving(true);
    try {
      const latest = await api.aiConfig();
      if (
        latest.connection.url !== config.connection.url ||
        latest.connection.protocol !== config.connection.protocol
      ) {
        setAIConfig(latest);
        throw new Error("连接已改变，请重新选择模型");
      }
      const models = { ...latest.models, ...modelEdits };
      setAIConfig(
        await api.saveAIConfig({
          ...nativeConfigUpdate(latest),
          models,
          efforts: { ...latest.efforts, ...effortEdits },
        }),
      );
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setAIModelSaving(false);
    }
  };
  const probe = async (role: AIModelRole) => {
    const seconds = Number(wait);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) return;
    const snapshot = config;
    setChecking(role);
    setError("");
    setChecks((old) => ({ ...old, [role]: undefined }));
    try {
      const result = await api.checkNativeAI(
        role,
        config.models[role] || undefined,
        seconds,
      );
      if (useReaderStore.getState().aiConfig === snapshot)
        setChecks((old) => ({ ...old, [role]: result }));
    } catch (error) {
      if (useReaderStore.getState().aiConfig === snapshot) {
        setError((error as Error).message);
        setChecks((old) => ({
          ...old,
          [role]: {
            text: false,
            vision: false,
            checkedAt: "",
            model: snapshot.models[role] ?? "",
            fingerprint: "",
            error: (error as Error).message,
          },
        }));
      }
    } finally {
      setChecking(null);
      // A check can persist text=false as well as success. Refresh all model
      // consumers; a delayed result must not invalidate another connection.
      invalidateAICatalog(snapshot);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">用途模型</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || saving}
          onClick={() => void refresh()}
        >
          刷新模型列表
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-muted-foreground">
          {error}
        </p>
      )}
      {roles.map(([role, label, placeholder]) => {
        const choice = taskChoice(config, role);
        const model = modelEdits[role] ?? choice.model;
        const effort = effortEdits[role] ?? choice.effort;
        const metadata = selectedAgentModel(catalog, model, role)?.effortInfo;
        const fixed =
          metadata?.mode === "fixed" || metadata?.mode === "unknown";
        const result =
          checking === role
            ? undefined
            : (checks[role] ??
              selectedAgentModel(catalog, model, role)?.capability);
        return (
          <div key={role} className="space-y-1">
            <div className="flex items-center gap-2">
              <label
                htmlFor={`${id}-${role}`}
                className="w-10 shrink-0 text-sm"
              >
                {label}
              </label>
              <Select
                value={model || null}
                disabled={disabled || saving || !!checking}
                onValueChange={(value) => {
                  if (
                    typeof value === "string" &&
                    (value === "" || catalog.some((item) => item.id === value))
                  )
                    setModelEdits((old) => ({ ...old, [role]: value }));
                }}
              >
                <SelectTrigger
                  id={`${id}-${role}`}
                  aria-label={`${label}模型`}
                  className="min-w-0 flex-1"
                >
                  <SelectValue>
                    <span className="truncate">{model || placeholder}</span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  <SelectItem value="">{placeholder}</SelectItem>
                  {catalog.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.id}
                    </SelectItem>
                  ))}
                  {catalog.length === 0 && (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                      暂无可选模型，请刷新列表
                    </p>
                  )}
                </SelectContent>
              </Select>
              <Select
                value={effort}
                disabled={disabled || saving || fixed || !!checking}
                onValueChange={(value) => {
                  if (efforts.includes(value as ReasoningEffort))
                    setEffortEdits((old) => ({
                      ...old,
                      [role]: value as ReasoningEffort,
                    }));
                }}
              >
                <SelectTrigger
                  className="w-28 shrink-0"
                  aria-label={`${label} Effort`}
                >
                  <SelectValue>
                    {fixed ? "固定／自动" : effortLabel(effort)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {efforts.map((value) => (
                    <SelectItem key={value} value={value}>
                      {effortLabel(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  disabled ||
                  saving ||
                  !!checking ||
                  !!config.needsConfiguration ||
                  Object.keys(modelEdits).length > 0 ||
                  Object.keys(effortEdits).length > 0
                }
                onClick={() => void probe(role)}
              >
                {checking === role ? "检测中…" : `检测${label}`}
              </Button>
            </div>
            {metadata && (
              <p className="text-xs text-muted-foreground">
                {metadata.note}
                {!fixed &&
                metadata.mappings?.[effort] &&
                metadata.mappings[effort] !== effort
                  ? ` ${effort} → ${metadata.mappings[effort]}${metadata.mode === "budget" ? " tokens" : ""}`
                  : ""}
              </p>
            )}
            {result && (
              <p role="status" className="text-xs text-muted-foreground">
                {result.text ? "文字可用" : "文字未通过"}
                {role === "vision"
                  ? result.vision
                    ? "；图片可用"
                    : "；图片未通过，使用纯文字模式"
                  : ""}
                {result.tools === "passed"
                  ? "；工具可用"
                  : result.tools
                    ? "；工具未通过，使用文字检索"
                    : ""}
                {result.error ? `：${result.error}` : ""}
                {result.textFirstOutputMs != null
                  ? `；文本首输出 ${(result.textFirstOutputMs / 1000).toFixed(2)} s`
                  : ""}
                {result.visionFirstOutputMs != null
                  ? `；图片首输出 ${(result.visionFirstOutputMs / 1000).toFixed(2)} s`
                  : ""}
              </p>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <label className="text-xs text-muted-foreground">检测等待（秒）</label>
        <Input
          aria-label="检测等待（秒）"
          type="number"
          min={1}
          max={60}
          value={wait}
          onChange={(event) => setWait(event.target.value)}
          className="w-20"
        />
        <Button
          variant="outline"
          disabled={
            disabled ||
            saving ||
            !!checking ||
            !(Object.keys(modelEdits).length || Object.keys(effortEdits).length)
          }
          onClick={() => void save()}
        >
          保存模型
        </Button>
      </div>
    </div>
  );
}
