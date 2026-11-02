import { useEffect, useRef, useState } from "react";
import {
  Plus,
  PencilSimple,
  CircleNotch,
  DotsThree,
  Trash,
  Check,
} from "@phosphor-icons/react";
import { api } from "@interleaf/api";
import type { ChatSessionDeletion, DocumentChatSession } from "@interleaf/core";
import { Button } from "@interleaf/ui/components/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@interleaf/ui/components/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@interleaf/ui/components/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@interleaf/ui/components/alert-dialog";
import { Input } from "@interleaf/ui/components/input";
import { toast } from "sonner";

const statusLabels = {
  running: "运行中",
  completed: "已完成",
  failed: "未完成",
  cancelled: "已停止",
  interrupted: "已中断",
};
type SessionPickerProps = {
  documentId: string;
  sessions: DocumentChatSession[];
  current?: DocumentChatSession;
  provider: string;
  running?: boolean;
  onChange: (id: string) => void;
  onRefresh: () => Promise<void>;
  onDeleted?: (id: string, result: ChatSessionDeletion) => void;
};

export function SessionPicker(props: SessionPickerProps) {
  return <DocumentSessionPicker key={props.documentId} {...props} />;
}

function DocumentSessionPicker({
  documentId,
  sessions,
  current,
  provider,
  running = false,
  onChange,
  onRefresh,
  onDeleted,
}: SessionPickerProps) {
  const status = running ? "running" : current?.latestRun?.status;
  const [managerOpen, setManagerOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<DocumentChatSession>();
  const [deleteTarget, setDeleteTarget] = useState<DocumentChatSession>();
  const [deleteError, setDeleteError] = useState("");
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const operation = useRef({ alive: true, pending: false });
  useEffect(() => {
    const scope = operation.current;
    scope.alive = true;
    return () => {
      scope.alive = false;
    };
  }, []);
  const isRunning = (session: DocumentChatSession) =>
    (session.id === current?.id && running) ||
    session.latestRun?.status === "running";
  const begin = () => {
    if (!operation.current.alive || operation.current.pending) return false;
    operation.current.pending = true;
    setSaving(true);
    return true;
  };
  const end = () => {
    operation.current.pending = false;
    if (operation.current.alive) setSaving(false);
  };
  const rename = (session: DocumentChatSession) => {
    setName(session.title);
    setRenameTarget(session);
  };
  const create = async () => {
    if (!begin()) return;
    try {
      const session = await api.createChatSession(
        documentId,
        provider || "api",
      );
      if (!operation.current.alive) return;
      await onRefresh();
      if (operation.current.alive) onChange(session.id);
    } catch (error) {
      if (operation.current.alive) toast.error((error as Error).message);
    } finally {
      end();
    }
  };
  const update = async (title: string) => {
    if (!renameTarget || !title.trim() || !begin()) return;
    try {
      await api.updateChatSession(documentId, renameTarget.id, {
        title: title.trim(),
      });
      if (!operation.current.alive) return;
      await onRefresh();
      if (operation.current.alive) setRenameTarget(undefined);
    } catch (error) {
      if (operation.current.alive) toast.error((error as Error).message);
    } finally {
      end();
    }
  };
  const remove = async () => {
    if (
      !deleteTarget ||
      isRunning(
        sessions.find((s) => s.id === deleteTarget.id) ?? deleteTarget,
      ) ||
      !begin()
    )
      return;
    const target = deleteTarget;
    setDeleteError("");
    try {
      const result = await api.deleteChatSession(documentId, target.id);
      // The old document still needs cache cleanup when its viewer was closed.
      onDeleted?.(target.id, result);
      if (!operation.current.alive) return;
      setRemoved((items) => new Set(items).add(target.id));
      setDeleteTarget(undefined);
      toast.success("会话已删除");
      try {
        await onRefresh();
      } catch (error) {
        if (operation.current.alive)
          toast.error(`会话已删除，列表刷新失败：${(error as Error).message}`);
      }
    } catch (error) {
      if (operation.current.alive) setDeleteError((error as Error).message);
    } finally {
      end();
    }
  };
  return (
    <div className="session-picker">
      <div className="session-picker-row">
        <Select
          value={current?.id ?? null}
          onValueChange={(id) => {
            if (id) onChange(id);
          }}
        >
          <SelectTrigger
            className="session-picker-trigger"
            aria-label="选择会话"
          >
            <SelectValue className="truncate">
              {current?.title ?? "加载会话…"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {sessions.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                <span className="max-w-44 truncate">{s.title}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {s.latestRun ? statusLabels[s.latestRun.status] : ""}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {status && (
          <span className="session-status" data-status={status} role="status">
            {status === "running" ? (
              <CircleNotch
                className="size-2.5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <span className="session-status-dot" aria-hidden="true" />
            )}
            {statusLabels[status]}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          className="session-picker-action"
          title="重命名会话"
          aria-label="重命名会话"
          disabled={!current || saving}
          onClick={() => {
            if (current) rename(current);
          }}
        >
          <PencilSimple />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="session-picker-action"
          title="会话管理"
          aria-label="会话管理"
          disabled={saving || !sessions.length}
          onClick={() => setManagerOpen(true)}
        >
          <DotsThree />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="session-picker-action"
          title="新建会话"
          aria-label="新建会话"
          disabled={saving}
          onClick={() => void create()}
        >
          <Plus />
        </Button>
      </div>
      <Dialog
        open={managerOpen}
        onOpenChange={(open) => {
          if (!operation.current.pending) setManagerOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-md" showCloseButton={!saving}>
          <DialogHeader>
            <DialogTitle>会话管理</DialogTitle>
            <DialogDescription>管理当前文档的对话。</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1">
            {sessions
              .filter((item) => !removed.has(item.id))
              .map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-1 border-b py-2 last:border-0"
                >
                  <Button
                    variant="ghost"
                    className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-2 text-left"
                    disabled={saving}
                    onClick={() => {
                      onChange(item.id);
                      setManagerOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {item.title}
                    </span>
                    {item.id === current?.id && (
                      <Check
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-label="当前会话"
                      />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`重命名会话：${item.title}`}
                    title="重命名"
                    disabled={saving}
                    onClick={() => rename(item)}
                  >
                    <PencilSimple />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive"
                    aria-label={`删除会话：${item.title}`}
                    title={
                      isRunning(item)
                        ? "请先停止该会话的回答，再删除"
                        : "删除会话"
                    }
                    disabled={saving || isRunning(item)}
                    onClick={() => {
                      setDeleteError("");
                      setDeleteTarget(item);
                    }}
                  >
                    <Trash />
                  </Button>
                </div>
              ))}
          </div>
          {sessions.some(isRunning) && (
            <p className="text-sm text-muted-foreground">
              正在生成回答的会话，请先停止回答再删除。
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!renameTarget}
        onOpenChange={(open) => {
          if (!open && !operation.current.pending) setRenameTarget(undefined);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void update(name);
            }}
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              aria-label="会话名称"
              autoFocus
            />
            <Button type="submit" disabled={saving || !name.trim()}>
              保存
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !operation.current.pending) setDeleteTarget(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除会话？</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              将删除“{deleteTarget?.title}
              ”的聊天记录和未发送草稿，此操作无法撤销。文档、笔记和批注会保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p role="alert" className="text-sm text-destructive">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              aria-label="确认删除会话"
              disabled={
                saving ||
                (!!deleteTarget &&
                  isRunning(
                    sessions.find((s) => s.id === deleteTarget.id) ??
                      deleteTarget,
                  ))
              }
              onClick={() => void remove()}
            >
              {saving ? "删除中…" : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
