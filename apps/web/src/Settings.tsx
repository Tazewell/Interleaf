import { ShortcutPanel } from "./shortcuts/ShortcutPanel";
import { AISettings } from "./ai/AISettings";
import { AutoTranslationSettings } from "./papers/AutoTranslationSettings";
import { useEffect, useState } from "react";
import {
  FileText,
  Robot as Bot,
  HighlighterCircle as Highlighter,
  Books as Library,
  Monitor,
  Keyboard,
  ArrowsClockwise as RefreshCw,
} from "@phosphor-icons/react";
import { DiagnosticExport } from "./DiagnosticExport";
import { LibraryLocationSettings } from "./LibraryLocationSettings";
import { CommandLineSettings } from "./CommandLineSettings";
import { api } from "@interleaf/api";
import type {
  LibraryMode,
  JournalRankConfig,
  PaperColumn,
} from "@interleaf/core";
import { Button } from "@interleaf/ui/components/button";
import { Input } from "@interleaf/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@interleaf/ui/components/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@interleaf/ui/components/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@interleaf/ui/components/tabs";
import { HighlightColorsEditor } from "./HighlightColorsEditor";
import { SlidingTabsList } from "./controls/SlidingTabsList";
import { ProxySettings } from "./ProxySettings";
import {
  primaryLibraryMode,
  updateLibraryPreferences,
  useReaderStore,
} from "./store";
import { libraryModes } from "./LibraryModeSwitcher";
import { Checkbox } from "@interleaf/ui/components/checkbox";
import { toast } from "sonner";
import { columnLabels, defaultColumns, toggleColumn } from "./papers/model";
import { savePaperPreferences } from "./papers/actions";
export function Settings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const [journalRank, setJournalRank] = useState<JournalRankConfig | null>(
    null,
  );
  const [journalKey, setJournalKey] = useState("");
  const [journalSaving, setJournalSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    let mounted = true;
    void api
      .journalRankConfig()
      .then((config) => {
        if (mounted) setJournalRank(config);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [open]);
  const saveJournalRank = async (
    patch: Partial<
      Pick<JournalRankConfig, "enabled" | "filterMode" | "selected">
    >,
    key?: string,
  ) => {
    if (!journalRank) return;
    setJournalSaving(true);
    try {
      const saved = await api.saveJournalRankConfig({
        enabled: patch.enabled ?? journalRank.enabled,
        filterMode: patch.filterMode ?? journalRank.filterMode,
        selected: patch.selected ?? journalRank.selected,
        ...(key !== undefined ? { key } : {}),
      });
      setJournalRank(saved);
      setJournalKey("");
      window.dispatchEvent(new Event("interleaf:journal-rank-config"));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setJournalSaving(false);
    }
  };
  const { theme, setTheme, libraryPreferences } = useReaderStore();
  const paperPreferences =
    useReaderStore((s) => s.libraryPreferences.papers) || {};
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="settings-dialog">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription className="sr-only">
            AI 连接、显示、阅读、快捷键、诊断与论文库
          </DialogDescription>
        </DialogHeader>
        <Tabs
          defaultValue="agent"
          orientation="vertical"
          className="settings-tabs"
        >
          <TabsList aria-label="设置分类" className="settings-nav">
            <TabsTrigger value="agent">
              <Bot />
              AI
            </TabsTrigger>
            <TabsTrigger value="display">
              <Monitor />
              显示
            </TabsTrigger>
            <TabsTrigger value="reading">
              <Highlighter />
              阅读
            </TabsTrigger>
            <TabsTrigger value="shortcuts">
              <Keyboard />
              快捷键
            </TabsTrigger>
            <TabsTrigger value="diagnostics">
              <FileText />
              诊断
            </TabsTrigger>
            <TabsTrigger value="papers">
              <Library />
              论文库
            </TabsTrigger>
          </TabsList>
          <TabsContent value="shortcuts" className="settings-panel">
            <ShortcutPanel />
          </TabsContent>
          <TabsContent
            value="diagnostics"
            className="settings-panel"
            keepMounted
          >
            <h2 className="settings-title">诊断</h2>
            {window.interleafDesktop?.proxySettings && (
              <div className="mb-6">
                <ProxySettings open={open} />
              </div>
            )}
            <section>
              <h3 className="mb-3 text-sm font-medium">本地日志</h3>
              <p className="mb-4 text-xs leading-5 text-muted-foreground">
                导出全部已保留日志和运行环境供开发者排查。凭据、用户路径和翻译诊断中的正文会脱敏；不包含文档、聊天或批注。日志最多保留
                7 天、100 MiB，仅在本机保存。
              </p>
              <DiagnosticExport />
            </section>
          </TabsContent>
          <TabsContent value="display" className="settings-panel" keepMounted>
            <h2 className="settings-title">显示</h2>
            <section className="mb-6">
              <h3
                id="primary-library-label"
                className="mb-3 text-sm font-medium"
              >
                主要模式
              </h3>
              <Select
                value={primaryLibraryMode(libraryPreferences)}
                onValueChange={(value) => {
                  if (value !== "papers" && value !== "books") return;
                  void updateLibraryPreferences({ primaryMode: value }).catch(
                    (error) => toast.error((error as Error).message),
                  );
                }}
              >
                <SelectTrigger
                  aria-labelledby="primary-library-label"
                  className="w-48"
                >
                  <SelectValue>
                    {libraryModes[primaryLibraryMode(libraryPreferences)].label}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(libraryModes) as LibraryMode[]).map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {libraryModes[mode].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-2 text-xs text-muted-foreground">
                下次启动时默认进入此模式。
              </p>
            </section>
            <section>
              <h3 className="mb-3 text-sm font-medium">界面主题</h3>
              <Tabs
                value={theme.appearance ?? "system"}
                onValueChange={(value) => {
                  if (
                    value !== "light" &&
                    value !== "sepia" &&
                    value !== "dark" &&
                    value !== "system"
                  )
                    return;
                  setTheme({
                    appearance: value,
                    mode:
                      value === "dark" || value === "sepia" ? value : "light",
                  });
                }}
              >
                <SlidingTabsList
                  aria-label="界面主题"
                  className="settings-appearance"
                >
                  {(["light", "sepia", "dark", "system"] as const).map(
                    (mode, i) => (
                      <TabsTrigger key={mode} value={mode}>
                        {["浅色", "纸张", "深色", "跟随系统"][i]}
                      </TabsTrigger>
                    ),
                  )}
                </SlidingTabsList>
              </Tabs>
            </section>
            <section className="mt-6">
              <label
                className="mb-2 block text-sm font-medium"
                htmlFor="pdf-dark-image-mode"
              >
                PDF 深色图像处理
              </label>
              <Select
                value={theme.pdfDarkImageMode ?? "adaptive"}
                onValueChange={(value) => {
                  if (
                    value === "preserve" ||
                    value === "invert" ||
                    value === "adaptive"
                  )
                    setTheme({ pdfDarkImageMode: value });
                }}
              >
                <SelectTrigger
                  id="pdf-dark-image-mode"
                  className="w-full max-w-sm"
                >
                  <SelectValue>
                    {
                      {
                        preserve: "保持原色（透明底补白）",
                        invert: "图片全部反色",
                        adaptive: "自适应深色（处理图片白底）",
                      }[theme.pdfDarkImageMode ?? "adaptive"]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="adaptive">
                    自适应深色（处理图片白底）
                  </SelectItem>
                  <SelectItem value="preserve">
                    保持原色（透明底补白）
                  </SelectItem>
                  <SelectItem value="invert">图片全部反色</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-2 text-xs text-muted-foreground">
                扫描版页面也按此选项处理；文字颜色会保留色相并调整亮度。
              </p>
            </section>
          </TabsContent>
          <TabsContent value="reading" className="settings-panel" keepMounted>
            <h2 className="settings-title">阅读</h2>
            <section className="mb-6 space-y-4">
              <label className="block text-sm">
                文档上下文上限（可选）
                <Input
                  className="mt-2 max-w-48"
                  type="number"
                  min={8192}
                  max={1048576}
                  step={1024}
                  defaultValue={theme.documentContextTokens || ""}
                  placeholder="自动获取"
                  key={theme.documentContextTokens}
                  onBlur={(e) => {
                    const n = Number(e.currentTarget.value);
                    if (
                      Number.isInteger(n) &&
                      (n === 0 || n >= 8192) &&
                      n <= 1048576
                    )
                      setTheme({ documentContextTokens: n });
                    else
                      e.currentTarget.value = String(
                        theme.documentContextTokens || "",
                      );
                  }}
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  优先读取模型信息；留空为自动，无法确定时采用
                  64K。填写后只限制上限。
                </span>
              </label>
            </section>
            <section className="mb-6">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={theme.autoCopySelection === true}
                  onCheckedChange={(checked) =>
                    setTheme({ autoCopySelection: !!checked })
                  }
                />
                <span>
                  自动复制选中文字
                  <span className="block text-xs text-muted-foreground">
                    选中文字或点击高亮、划线等批注时，自动复制到剪贴板
                  </span>
                </span>
              </label>
            </section>
            <section className="mb-6">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={theme.autoTranslateSelection === true}
                  onCheckedChange={(checked) =>
                    setTheme({ autoTranslateSelection: checked === true })
                  }
                />
                <span>
                  自动划词翻译
                  <span className="block text-xs text-muted-foreground">
                    选定文字后，在选区菜单下方自动显示 AI 译文
                  </span>
                </span>
              </label>
            </section>
            <section className="mb-6">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={theme.linkTranslationAnnotations !== false}
                  onCheckedChange={(checked) =>
                    setTheme({ linkTranslationAnnotations: !!checked })
                  }
                />
                <span>
                  原文译文悬停关联
                  <span className="block text-xs text-muted-foreground">
                    悬停时提示另一侧对应的完整句子
                  </span>
                </span>
              </label>
            </section>
            <section>
              <h3 className="mb-3 text-sm font-medium">高亮颜色</h3>
              <HighlightColorsEditor />
            </section>
          </TabsContent>
          <TabsContent value="papers" className="settings-panel" keepMounted>
            <h2 className="settings-title">论文库</h2>
            {window.interleafDesktop?.libraryLocation && (
              <div className="mb-6">
                <LibraryLocationSettings open={open} />
              </div>
            )}
            <section>
              <h3 className="mb-3 text-sm font-medium">导入设置</h3>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={paperPreferences.autoLookup !== false}
                  onCheckedChange={(checked) =>
                    void updateLibraryPreferences({
                      papers: { ...paperPreferences, autoLookup: !!checked },
                    }).catch((e) => toast.error(e.message))
                  }
                />
                <span>
                  导入 PDF 后自动补全论文信息
                  <span className="block text-xs text-muted-foreground">
                    只把文中的 DOI 或 arXiv 编号发送给 arXiv、Crossref 与
                    Semantic Scholar
                  </span>
                </span>
              </label>
              <label className="mt-4 flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={theme.autoGenerateOverview ?? false}
                  onCheckedChange={(checked) =>
                    setTheme({ autoGenerateOverview: !!checked })
                  }
                />
                <span>
                  导入后生成文档概要
                  <span className="block text-xs text-muted-foreground">
                    使用已配置的文字模型，单独记录用量；已有文档按需生成。
                  </span>
                </span>
              </label>
              <AutoTranslationSettings theme={theme} setTheme={setTheme} />
            </section>
            <fieldset className="mt-7 border-t pt-5">
              <legend className="text-sm font-medium">表格显示列</legend>
              <p className="mb-3 text-xs text-muted-foreground">
                标题始终显示。以下选择应用于论文库的表格视图。
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                {(Object.keys(columnLabels) as PaperColumn[]).map((column) => (
                  <label
                    key={column}
                    htmlFor={`paper-column-${column}`}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      id={`paper-column-${column}`}
                      checked={(
                        paperPreferences.columns ?? defaultColumns
                      ).includes(column)}
                      onCheckedChange={() =>
                        void savePaperPreferences((prefs) => ({
                          ...prefs,
                          columns: toggleColumn(
                            prefs.columns ?? defaultColumns,
                            column,
                          ),
                        }))
                      }
                    />
                    {columnLabels[column]}
                  </label>
                ))}
              </div>
            </fieldset>
            <section className="mt-7 border-t pt-5">
              <h3 className="mb-3 text-sm font-medium">期刊指标</h3>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={journalRank?.enabled ?? true}
                  disabled={!journalRank || journalSaving}
                  onCheckedChange={(checked) =>
                    void saveJournalRank({ enabled: !!checked })
                  }
                />
                <span>
                  在论文库显示 easyScholar 期刊指标
                  <span className="block text-xs text-muted-foreground">
                    默认开启；配置 SecretKey 后按论文出处查询。
                  </span>
                </span>
              </label>
              {journalRank?.enabled && (
                <>
                  <div className="mt-4 flex items-center gap-2">
                    <Input
                      type="password"
                      autoComplete="off"
                      aria-label="easyScholar SecretKey"
                      placeholder={
                        journalRank.hasKey
                          ? "已保存 SecretKey；输入新密钥可替换"
                          : "输入 easyScholar SecretKey"
                      }
                      value={journalKey}
                      onChange={(event) => setJournalKey(event.target.value)}
                    />
                    <Button
                      variant="outline"
                      disabled={!journalKey.trim() || journalSaving}
                      onClick={() =>
                        void saveJournalRank({}, journalKey.trim())
                      }
                    >
                      保存
                    </Button>
                  </div>
                  <div className="mt-4 flex items-center gap-2 text-xs">
                    <span id="journal-rank-filter-label">指标筛选</span>
                    <Select
                      value={journalRank.filterMode}
                      onValueChange={(value) => {
                        if (value !== "include" && value !== "exclude") return;
                        void saveJournalRank({
                          filterMode: value,
                          selected:
                            value === "include"
                              ? journalRank.available.map((field) => field.key)
                              : [],
                        });
                      }}
                      disabled={journalSaving}
                    >
                      <SelectTrigger
                        aria-labelledby="journal-rank-filter-label"
                        className="w-48"
                      >
                        <SelectValue>
                          {journalRank.filterMode === "include"
                            ? "只显示选中的指标"
                            : "隐藏选中的指标"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="include">
                          只显示选中的指标
                        </SelectItem>
                        <SelectItem value="exclude">隐藏选中的指标</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {journalRank.filterMode === "include"
                      ? "勾选要显示的指标。"
                      : "勾选不想显示的指标。"}
                    无数据或超出标题列宽度的标签会省略。
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
                    {journalRank.available.map((field) => (
                      <label
                        key={field.key}
                        className="flex min-w-0 items-center gap-2 text-xs"
                      >
                        <Checkbox
                          checked={journalRank.selected.includes(field.key)}
                          disabled={journalSaving}
                          onCheckedChange={(checked) =>
                            void saveJournalRank({
                              selected: checked
                                ? [...journalRank.selected, field.key]
                                : journalRank.selected.filter(
                                    (value) => value !== field.key,
                                  ),
                            })
                          }
                        />
                        <span className="truncate" title={field.name}>
                          {field.name}
                        </span>
                      </label>
                    ))}
                  </div>
                  {journalRank.hasKey && (
                    <Button
                      className="mt-4"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        window.dispatchEvent(
                          new Event("interleaf:journal-rank-refresh"),
                        )
                      }
                    >
                      <RefreshCw />
                      刷新当前列表的期刊指标
                    </Button>
                  )}
                </>
              )}
            </section>
          </TabsContent>
          <TabsContent value="agent" className="settings-panel" keepMounted>
            <AISettings open={open} />
            <CommandLineSettings open={open} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
