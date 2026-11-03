import { useEffect, useState } from "react";
import {
  FileArrowUp as FileUp,
  FolderOpen,
  CircleNotch as LoaderCircle,
} from "@phosphor-icons/react";
import { Button } from "@interleaf/ui/components/button";
import { Input } from "@interleaf/ui/components/input";
import { Tabs, TabsContent, TabsTrigger } from "@interleaf/ui/components/tabs";
import { SlidingTabsList } from "../controls/SlidingTabsList";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@interleaf/ui/components/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@interleaf/ui/components/dialog";
import { toast } from "sonner";
import { libraryModes } from "../LibraryModeSwitcher";
import { importReference } from "./actions";
import { paperCategories } from "./model";
import { usePaperUI } from "./state";
import { useReaderStore } from "../store";
import { ZoteroImportForm } from "./ZoteroImportDialog";
import { BibliographyImportForm } from "./BibliographyImportDialog";

type ImportMethod = "reference" | "file" | "migration" | "bibtex";

export function ImportPaperDialog({
  open,
  onOpenChange,
  onChooseFiles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChooseFiles: (folder: string) => void;
}) {
  const [method, setMethod] = useState<ImportMethod>("reference");
  const [migration, setMigration] = useState<"zotero" | "endnote">("zotero");
  const [migrationVisited, setMigrationVisited] = useState(false);
  const [ref, setRef] = useState("");
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [bibliographyBusy, setBibliographyBusy] = useState(false);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const busy = referenceBusy || bibliographyBusy || migrationBusy;
  const [folder, setFolder] = useState("");
  const { documents, libraryPreferences } = useReaderStore();
  const categories = paperCategories(
    libraryPreferences.papers || {},
    documents.filter((doc) => doc.library === "papers"),
  );
  const smartCategories = libraryPreferences.papers?.smartCategories || [];
  const smart = smartCategories.find((item) => `smart:${item.id}` === folder);
  useEffect(() => {
    if (!open) return;
    const view = usePaperUI.getState().view;
    const current =
      view.startsWith("folder:") && categories.includes(view.slice(7))
        ? view
        : view.startsWith("smart:") &&
            smartCategories.some((item) => `smart:${item.id}` === view)
          ? view
          : "";
    setFolder(current);
    // Capture the current view when the dialog opens, not when the library refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const submit = async () => {
    if (!ref.trim() || busy) return;
    setReferenceBusy(true);
    try {
      const doc = await importReference(ref, folder);
      if (doc.library === "papers") toast.success(`已导入《${doc.title}》`);
      else
        toast.info(
          `这篇论文已在${libraryModes[doc.library].label}中，可在那里移动`,
        );
      setRef("");
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReferenceBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="paper-import-dialog sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>导入论文</DialogTitle>
          <DialogDescription>
            从链接、本地文件或已有文献库添加论文。
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={method}
          onValueChange={(value) => {
            if (busy) return;
            setMethod(value as ImportMethod);
            if (value === "migration") setMigrationVisited(true);
          }}
          className="paper-import-tabs"
        >
          <SlidingTabsList
            aria-label="导入方式"
            className="paper-import-methods"
          >
            <TabsTrigger value="reference" disabled={busy}>
              链接与标识
            </TabsTrigger>
            <TabsTrigger value="file" disabled={busy}>
              本地文件
            </TabsTrigger>
            <TabsTrigger value="migration" disabled={busy}>
              文献库迁移
            </TabsTrigger>
            <TabsTrigger value="bibtex" disabled={busy}>
              BibTeX
            </TabsTrigger>
          </SlidingTabsList>
          <div className="paper-import-sheet">
            <TabsContent value="reference" keepMounted>
              <form
                className="paper-import-reference"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <label htmlFor="import-paper-reference">论文标识或链接</label>
                <Input
                  id="import-paper-reference"
                  autoFocus
                  autoComplete="off"
                  aria-label="论文标识或链接"
                  aria-describedby="import-paper-reference-help"
                  placeholder="例如 2401.01234 或 10.1145/…"
                  value={ref}
                  disabled={busy}
                  onChange={(e) => setRef(e.target.value)}
                />
                <p
                  className="paper-import-help"
                  id="import-paper-reference-help"
                >
                  支持 arXiv 编号、DOI、论文页面、PDF 链接或完整标题。
                </p>
                <div className="paper-import-actions">
                  <Button
                    className="paper-import-primary"
                    type="submit"
                    disabled={!ref.trim() || busy}
                  >
                    {referenceBusy && <LoaderCircle className="animate-spin" />}
                    {referenceBusy ? "下载中" : "导入"}
                  </Button>
                </div>
              </form>
            </TabsContent>
            <TabsContent value="file" keepMounted>
              <div className="paper-import-files">
                <FileUp aria-hidden="true" />
                <strong>添加本地 PDF</strong>
                <p className="paper-import-help">支持同时选择多篇论文。</p>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    onOpenChange(false);
                    onChooseFiles(folder);
                  }}
                >
                  <FolderOpen />
                  选择 PDF 文件
                </Button>
              </div>
            </TabsContent>
            <TabsContent value="migration" keepMounted>
              <Tabs
                value={migration}
                onValueChange={(value) =>
                  !busy && setMigration(value as "zotero" | "endnote")
                }
                className="paper-import-source"
              >
                <SlidingTabsList aria-label="文献库来源">
                  <TabsTrigger value="zotero" disabled={busy}>
                    Zotero
                  </TabsTrigger>
                  <TabsTrigger value="endnote" disabled={busy}>
                    EndNote
                  </TabsTrigger>
                </SlidingTabsList>
                {migrationVisited && (
                  <TabsContent value={migration}>
                    <ZoteroImportForm
                      key={migration}
                      source={migration}
                      onClose={() => onOpenChange(false)}
                      onBusyChange={setMigrationBusy}
                    />
                  </TabsContent>
                )}
              </Tabs>
            </TabsContent>
            <TabsContent value="bibtex" keepMounted>
              <BibliographyImportForm
                onClose={() => onOpenChange(false)}
                onBusyChange={setBibliographyBusy}
              />
            </TabsContent>
            {(method === "reference" || method === "file") && (
              <div className="paper-import-target">
                <span
                  className="text-sm font-medium"
                  id="import-paper-folder-label"
                >
                  导入到分类
                </span>
                <Select
                  value={folder || "none"}
                  onValueChange={(value) =>
                    setFolder(value === "none" ? "" : value || "")
                  }
                  disabled={busy}
                >
                  <SelectTrigger
                    aria-labelledby="import-paper-folder-label"
                    className="w-full"
                  >
                    <SelectValue>
                      {smart
                        ? `${smart.name}（智能标签）`
                        : folder
                          ? folder.slice(7).replaceAll("/", " / ")
                          : "未分类"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">未分类</SelectItem>
                    {categories.map((name) => (
                      <SelectItem key={name} value={`folder:${name}`}>
                        {name.replaceAll("/", " / ")}
                      </SelectItem>
                    ))}
                    {smartCategories.map((item) => (
                      <SelectItem
                        key={`smart:${item.id}`}
                        value={`smart:${item.id}`}
                      >
                        {item.name}（智能标签）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
