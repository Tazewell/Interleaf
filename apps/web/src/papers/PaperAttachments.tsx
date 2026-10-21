import { useState } from "react";
import type { Annotation, Document, PaperAttachmentRole } from "@reader/core";
import { api } from "@reader/api";
import { toast } from "sonner";
import { Button } from "@reader/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@reader/ui/components/select";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@reader/ui/components/alert-dialog";
import { refreshLibrary, useReaderStore } from "../store";
const roles: Record<PaperAttachmentRole, string> = {
  original: "原文",
  translation: "译文",
  supplement: "补充材料",
  other: "其他",
};
export function PaperAttachments({
  doc,
  open,
}: {
  doc: Document;
  open: (doc: Document) => void;
}) {
  const documents = useReaderStore((s) => s.documents);
  const [detaching, setDetaching] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, Annotation[]>>({});
  const [notesOpen, setNotesOpen] = useState<string | null>(null);
  const showNotes = async (documentId: string) => {
    if (notesOpen === documentId) {
      setNotesOpen(null);
      return;
    }
    setBusy(true);
    try {
      const values = await api.annotations(documentId);
      setNotes((n) => ({ ...n, [documentId]: values }));
      setNotesOpen(documentId);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!doc.paperId) return null;
  const available = documents.filter((d) => !d.paperId && !d.deletedAt);
  const save = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await refreshLibrary();
      setDetaching(null);
      setAdding("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-2 py-3" aria-label="文献附件">
      <h3 className="text-sm font-medium">
        附件（{doc.attachments?.length || 0}）
      </h3>
      {!doc.attachments?.length && (
        <p className="text-xs text-muted-foreground">
          尚无附件，可从图书库添加 PDF 或 EPUB。
        </p>
      )}
      {doc.attachments?.map((a) => {
        const file = documents.find((d) => d.id === a.documentId);
        return (
          <div key={a.documentId} className="space-y-1 rounded border p-2">
            <Button
              className="w-full justify-start overflow-hidden"
              size="sm"
              variant="ghost"
              disabled={!file}
              aria-label={`打开附件 ${a.title}`}
              onClick={() => file && open(file)}
            >
              <span className="truncate">{a.title}</span>
            </Button>
            <p className="text-xs text-muted-foreground">
              {file?.noteCount || 0} 条批注 · {file?.highlightCount || 0} 处划线
              · {Math.round((file?.percentage || 0) * 100)}%
            </p>
            {!!file &&
              file.noteCount + file.highlightCount + file.openQuestionCount >
                0 && (
                <Button
                  size="xs"
                  variant="link"
                  disabled={busy}
                  aria-label={`查看附件批注 ${a.title}`}
                  onClick={() => void showNotes(a.documentId)}
                >
                  {notesOpen === a.documentId ? "收起批注" : "查看批注"}
                </Button>
              )}
            {notesOpen === a.documentId && (
              <ul className="max-h-48 overflow-y-auto">
                {notes[a.documentId]?.map((note) => (
                  <li key={note.id}>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-full justify-start"
                      onClick={() => {
                        if (file) {
                          useReaderStore.getState().setLinkTarget({
                            id: file.id,
                            annotation: note.id,
                          });
                          open(file);
                        }
                      }}
                    >
                      <span className="truncate">
                        {note.note || note.quote || "批注"}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-1">
              <Select
                value={a.role}
                onValueChange={(v) =>
                  v &&
                  void save(() =>
                    api.attachPaper(
                      doc.paperId!,
                      a.documentId,
                      v as PaperAttachmentRole,
                    ),
                  )
                }
                disabled={busy}
              >
                <SelectTrigger size="sm" aria-label={`附件角色 ${a.title}`}>
                  <SelectValue>{roles[a.role]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(roles).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="xs"
                variant="outline"
                disabled={busy || doc.id === a.documentId}
                onClick={() =>
                  void save(() =>
                    api.attachPaper(doc.paperId!, a.documentId, a.role, true),
                  )
                }
              >
                {doc.id === a.documentId ? "默认附件" : "设为默认"}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                aria-label={`移出附件 ${a.title}`}
                onClick={() => setDetaching(a.documentId)}
              >
                移出
              </Button>
            </div>
          </div>
        );
      })}
      {available.length > 0 && (
        <div className="flex gap-1">
          <Select value={adding} onValueChange={(v) => setAdding(v || "")}>
            <SelectTrigger size="sm" aria-label="选择已有文件">
              <SelectValue placeholder="选择图书库文件" />
            </SelectTrigger>
            <SelectContent>
              {available.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={!adding || busy}
            onClick={() =>
              void save(() =>
                api.attachPaper(
                  doc.paperId!,
                  adding,
                  "original",
                  !doc.attachments?.length,
                ),
              )
            }
          >
            添加
          </Button>
        </div>
      )}
      <AlertDialog
        open={!!detaching}
        onOpenChange={(v) => !v && !busy && setDetaching(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>将附件移到图书库？</AlertDialogTitle>
            <AlertDialogDescription>
              保留文件及其阅读记录、批注、笔记和对话，只解除与这篇文献的关系。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() =>
                detaching &&
                void save(() => api.detachPaper(doc.paperId!, detaching))
              }
            >
              确认移出
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
