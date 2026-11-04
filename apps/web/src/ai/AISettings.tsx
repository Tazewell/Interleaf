import { useEffect, useState } from "react";
import { api } from "@interleaf/api";
import { nativeConfigUpdate, type NativeAIConfig } from "@interleaf/core";
import { Input } from "@interleaf/ui/components/input";
import { Button } from "@interleaf/ui/components/button";
import { Tabs, TabsContent, TabsTrigger } from "@interleaf/ui/components/tabs";
import { SlidingTabsList } from "../controls/SlidingTabsList";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@interleaf/ui/components/select";
import { TaskModels } from "../TaskModels";
import { TranslationPromptSettings } from "../TranslationPromptSettings";
import { useReaderStore } from "../store";
import { toast } from "sonner";
import {
  inferProvider,
  providerPresets,
  sameConnection,
  type ProviderPreset,
} from "./provider-presets";

export function AISettings({ open }: { open: boolean }) {
  const [section, setSection] = useState("connection");
  const { aiConfig: config, setAIConfig, aiModelSaving } = useReaderStore();
  const [url, setURL] = useState("");
  const [protocol, setProtocol] =
    useState<NativeAIConfig["connection"]["protocol"]>("openai");
  const [provider, setProvider] = useState<ProviderPreset>("custom");
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const before = useReaderStore.getState().aiConfig;
    void api
      .aiConfig()
      .then((config) => {
        if (
          !controller.signal.aborted &&
          useReaderStore.getState().aiConfig === before
        )
          setAIConfig(config);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [open, setAIConfig]);
  useEffect(() => {
    setURL(config?.connection.url ?? "");
    setProtocol(config?.connection.protocol ?? "openai");
    setProvider(inferProvider(config?.connection));
    setKey("");
    setClearKey(false);
  }, [
    config?.connection.url,
    config?.connection.protocol,
    config?.connection.hasKey,
  ]);
  const keepsSavedConnection =
    !!config && sameConnection(config.connection, { url, protocol });
  const connectionDraftChanged =
    !keepsSavedConnection || !!key.trim() || clearKey;
  const saveConnection = async () => {
    if (!config) return;
    setSaving(true);
    setError("");
    try {
      const latest = await api.aiConfig();
      const update = nativeConfigUpdate(latest);
      update.connection = {
        protocol,
        url: url.trim(),
        ...(key.trim() ? { key: key.trim() } : clearKey ? { key: null } : {}),
      };
      if (!sameConnection(latest.connection, update.connection)) {
        update.models = {};
        update.efforts = {};
        update.apiModels = [];
      }
      setAIConfig(await api.saveAIConfig(update));
      setKey("");
      setClearKey(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="ai-settings space-y-5">
      <h2 className="settings-title">AI</h2>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {config && (
        <>
          {config.needsConfiguration && (
            <p role="status" className="text-sm text-muted-foreground">
              {config.needsConfiguration}
            </p>
          )}
          <Tabs
            value={section}
            onValueChange={(value) => setSection(String(value))}
            className="ai-settings-tabs"
          >
            <SlidingTabsList
              aria-label="AI 设置分组"
              className="ai-settings-nav"
            >
              <TabsTrigger value="connection">连接</TabsTrigger>
              <TabsTrigger value="models">模型</TabsTrigger>
              <TabsTrigger value="translation">翻译提示</TabsTrigger>
            </SlidingTabsList>
            <TabsContent
              value="connection"
              keepMounted
              className="ai-settings-section"
            >
              <form
                className="ai-connection-form space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveConnection();
                }}
              >
                <label className="settings-field-label" htmlFor="ai-provider">
                  服务商
                </label>
                <Select
                  value={provider}
                  disabled={saving || aiModelSaving}
                  onValueChange={(value) => {
                    const preset = providerPresets.find(
                      (item) => item.id === value,
                    );
                    if (!preset && value !== "custom") return;
                    setProvider(value as ProviderPreset);
                    if (preset) {
                      setURL(preset.url);
                      setProtocol("openai");
                    }
                    setKey("");
                    setClearKey(false);
                  }}
                >
                  <SelectTrigger id="ai-provider" aria-label="服务商">
                    <SelectValue>
                      {providerPresets.find((item) => item.id === provider)
                        ?.label ?? "自定义"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {providerPresets.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.label}
                      </SelectItem>
                    ))}
                    <SelectItem value="custom">自定义</SelectItem>
                  </SelectContent>
                </Select>
                {provider === "bailian" && (
                  <p className="text-xs text-muted-foreground">
                    默认北京地域；其它地域请选自定义，地址与 Key
                    须属于同一地域。
                  </p>
                )}
                <label className="settings-field-label" htmlFor="ai-protocol">
                  API 协议
                </label>
                <Select
                  value={protocol}
                  disabled={saving || aiModelSaving || provider !== "custom"}
                  onValueChange={(value) => {
                    if (value === "openai" || value === "anthropic") {
                      setProtocol(value);
                      setKey("");
                      setClearKey(false);
                    }
                  }}
                >
                  <SelectTrigger id="ai-protocol" aria-label="API 协议">
                    <SelectValue>
                      {protocol === "openai" ? "OpenAI 兼容" : "Anthropic"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI 兼容</SelectItem>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                  </SelectContent>
                </Select>
                <label className="settings-field-label" htmlFor="ai-url">
                  API 地址
                </label>
                <Input
                  id="ai-url"
                  aria-label="API 地址"
                  placeholder="https://example.com/v1"
                  value={url}
                  disabled={saving || aiModelSaving || provider !== "custom"}
                  onChange={(event) => {
                    setURL(event.target.value);
                    setKey("");
                    setClearKey(false);
                  }}
                />
                <label className="settings-field-label" htmlFor="ai-key">
                  API Key
                </label>
                <Input
                  id="ai-key"
                  aria-label="API Key"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    keepsSavedConnection && config.connection.hasKey
                      ? "已保存；留空保留当前 Key"
                      : "API Key（本地服务可不填）"
                  }
                  value={key}
                  disabled={saving || aiModelSaving}
                  onChange={(event) => {
                    setKey(event.target.value);
                    setClearKey(false);
                  }}
                />
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={saving || aiModelSaving}
                    onClick={() => {
                      setKey("");
                      setClearKey(true);
                    }}
                  >
                    {clearKey ? "保存时清空 Key" : "清空 Key／无需密钥"}
                  </Button>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={saving || aiModelSaving}
                  >
                    保存连接
                  </Button>
                </div>
              </form>
            </TabsContent>
            <TabsContent
              value="models"
              keepMounted
              className="ai-settings-section ai-model-settings"
            >
              {connectionDraftChanged && (
                <p className="text-xs text-muted-foreground">
                  先保存连接，再选择模型。
                </p>
              )}
              <TaskModels
                disabled={
                  saving ||
                  !!config.needsConfiguration ||
                  connectionDraftChanged
                }
              />
            </TabsContent>
            <TabsContent
              value="translation"
              keepMounted
              className="ai-settings-section"
            >
              <TranslationPromptSettings
                value={config.translationPrompt ?? ""}
                disabled={
                  saving || aiModelSaving || !!config.needsConfiguration
                }
                onSave={async (translationPrompt) => {
                  setSaving(true);
                  try {
                    const latest = await api.aiConfig();
                    setAIConfig(
                      await api.saveAIConfig({
                        ...nativeConfigUpdate(latest),
                        translationPrompt,
                      }),
                    );
                    return true;
                  } catch (error) {
                    toast.error((error as Error).message);
                    return false;
                  } finally {
                    setSaving(false);
                  }
                }}
              />
            </TabsContent>
          </Tabs>
        </>
      )}
    </section>
  );
}
