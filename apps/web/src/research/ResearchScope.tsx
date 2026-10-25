import { useEffect, useState } from "react";
import { researchAPI } from "@reader/api";
import type { ResearchTopic } from "@reader/core";
import { Button } from "@reader/ui/components/button";
import { Input } from "@reader/ui/components/input";
import { Checkbox } from "@reader/ui/components/checkbox";
import { researchSignal } from "./research-session";
export function ResearchScope({
  topic,
  busy,
  onSaved,
}: {
  topic: ResearchTopic;
  busy: boolean;
  onSaved: () => void;
}) {
  const [folder, setFolder] = useState(topic.folder);
  const [children, setChildren] = useState(topic.includeChildren);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setFolder(topic.folder);
    setChildren(topic.includeChildren);
    setError("");
  }, [topic]);
  return (
    <details className="rounded-lg border p-3">
      <summary className="cursor-pointer text-sm">
        研究范围：{topic.folder || "全部论文"}
        {topic.scopeState === "detached" ? "（原文件夹已移除）" : ""}
      </summary>
      <div className="mt-3 space-y-2">
        <Input
          aria-label="研究文件夹"
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={children}
            onCheckedChange={(value) => setChildren(value === true)}
          />
          包含子文件夹
        </label>
        <p className="text-xs text-muted-foreground">
          每篇论文使用一份可读原文；更改范围在下次开始时生效。
        </p>
        <Button
          size="sm"
          disabled={busy || saving}
          onClick={async () => {
            const signal = researchSignal();
            setSaving(true);
            setError("");
            try {
              await researchAPI.updateTopic(
                topic.id,
                { folder, includeChildren: children },
                signal,
              );
              if (!signal.aborted) onSaved();
            } catch (error) {
              if (!signal.aborted) setError((error as Error).message);
            } finally {
              if (!signal.aborted) setSaving(false);
            }
          }}
        >
          保存范围
        </Button>
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  );
}
