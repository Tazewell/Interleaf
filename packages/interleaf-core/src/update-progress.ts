/** Visible update work, sent from the desktop shell; null clears it. */
export interface UpdateProgress {
  version: string;
  phase: "download" | "prepare";
  received: number;
  /** Undefined when the download size is unknown. */
  total?: number;
}

/** One pending desktop update choice, with no installer path or download URL. */
export interface UpdateOffer {
  id: number;
  currentVersion: string;
  version: string;
  actionLabel: "下载并安装" | "下载安装包";
}
