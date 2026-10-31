import { useEffect, useState } from "react";
import { api } from "@interleaf/api";
import { nativeConfigUpdate, type NativeAIConfig } from "@interleaf/core";
import { Input } from "@interleaf/ui/components/input";
import { Button } from "@interleaf/ui/components/button";
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

export function AISettings({ open }: { open: boolean }) {
  const { aiConfig: config, setAIConfig, aiModelSaving } = useReaderStore();
  const [url, setURL] = useState("");
  const [protocol, setProtocol] =
    useState<NativeAIConfig["connection"]["protocol"]>("openai");
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
    setKey("");
    setClearKey(false);
  }, [
    config?.connection.url,
    config?.connection.protocol,
    config?.connection.hasKey,
  ]);
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
    <section className="space-y-5">
      <h3 className="text-sm font-medium">AI 连接</h3>
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
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void saveConnection();
            }}
          >
            <Select
              value={protocol}
              disabled={saving || aiModelSaving}
              onValueChange={(value) => {
                if (value === "openai" || value === "anthropic")
                  setProtocol(value);
              }}
            >
              <SelectTrigger aria-label="API 协议">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI 兼容</SelectItem>
                <SelectItem value="anthropic">Anthropic</SelectItem>
              </SelectContent>
            </Select>
            <Input
              aria-label="API 地址"
              placeholder="https://example.com/v1"
              value={url}
              disabled={saving || aiModelSaving}
              onChange={(event) => setURL(event.target.value)}
            />
            <Input
              aria-label="API Key"
              type="password"
              autoComplete="off"
              placeholder={
                config.connection.hasKey
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
          <TaskModels disabled={saving || !!config.needsConfiguration} />
          <TranslationPromptSettings
            value={config.translationPrompt ?? ""}
            disabled={saving || aiModelSaving || !!config.needsConfiguration}
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
        </>
      )}
    </section>
  );
}
