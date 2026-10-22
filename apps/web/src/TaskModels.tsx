import { useEffect, useId, useState } from "react";
import { api } from "@reader/api";
import {
  nativeConfigUpdate,
  type NativeAIConfig,
  type AIModelRole,
  type AgentModel,
  type NativeAICheck,
  type ReasoningEffort,
} from "@reader/core";
import { Input } from "@reader/ui/components/input";
import { Button } from "@reader/ui/components/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@reader/ui/components/select";
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
  const [retry, setRetry] = useState(0);
  const revision = catalogRevision(config);
  useEffect(() => {
    setModelEdits({});
    setEffortEdits({});
    setChecks({});
  }, [config]);
  useEffect(() => {
    setCatalog([]);
    setError("");
    if (!config?.connection.url || config.needsConfiguration) return;
    const controller = new AbortController();
    void api
      .agentModels("chat", controller.signal)
      .then((models) => {
        if (!controller.signal.aborted) setCatalog(models);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [revision, config, retry]);
  if (!config) return null;
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
          apiModels: [
            ...new Set([
              ...latest.apiModels,
              ...(Object.values(models).filter(Boolean) as string[]),
            ]),
          ],
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
          onClick={() => setRetry((value) => value + 1)}
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
              <Input
                id={`${id}-${role}`}
                aria-label={`${label}模型`}
                list={`${id}-models`}
                placeholder={placeholder}
                value={model}
                disabled={disabled || saving || !!checking}
                onChange={(event) =>
                  setModelEdits((old) => ({
                    ...old,
                    [role]: event.target.value,
                  }))
                }
              />
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
      <datalist id={`${id}-models`}>
        {catalog.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </datalist>
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
