import { create } from "zustand";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@interleaf/ui/components/alert-dialog";

interface LargePaper {
  name: string;
  pages: number;
}

export function LargePaperDialog({
  papers,
  busy,
  onChoose,
  onCancel,
}: {
  papers: LargePaper[];
  busy: boolean;
  onChoose: (library: "papers" | "books") => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog
      open={papers.length > 0}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>检测到 PDF 过大</AlertDialogTitle>
          <AlertDialogDescription>
            请确认是否是论文？如果是图书类，请导入图书库。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {papers.some((paper) => paper.pages > 0) && (
          <ul className="max-h-40 space-y-1 overflow-auto text-sm text-muted-foreground">
            {papers.map((paper, index) => (
              <li key={index} className="break-words">
                {paper.name}
                {paper.pages > 0 ? ` · ${paper.pages} 页` : ""}
              </li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            disabled={busy}
            onClick={() => onChoose("books")}
          >
            不是论文，导入图书库
          </AlertDialogAction>
          <AlertDialogAction disabled={busy} onClick={() => onChoose("papers")}>
            确认是论文，仍然导入论文库
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const useLargeConfirmation = create<{
  pending?: { resolve: (library: "papers" | "books" | null) => void };
}>(() => ({}));
let confirmationQueue = Promise.resolve();
export function confirmLargePaper(): Promise<"papers" | "books" | null> {
  const next = confirmationQueue.then(
    () =>
      new Promise<"papers" | "books" | null>((resolve) => {
        useLargeConfirmation.setState({ pending: { resolve } });
      }),
  );
  confirmationQueue = next.then(() => {});
  return next;
}
export function LargePaperConfirmation() {
  const pending = useLargeConfirmation((state) => state.pending);
  const choose = (library: "papers" | "books" | null) => {
    useLargeConfirmation.setState({ pending: undefined });
    pending?.resolve(library);
  };
  return (
    <LargePaperDialog
      papers={pending ? [{ name: "PDF", pages: 0 }] : []}
      busy={false}
      onChoose={choose}
      onCancel={() => choose(null)}
    />
  );
}
