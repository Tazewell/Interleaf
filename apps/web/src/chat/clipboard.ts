import { toast } from "sonner";
// Embedded browsers and unfocused iframes reject the async clipboard API,
// so fall back to the selection-based copy that still works there.
function copySelection(text: string) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-9999px";
  area.style.opacity = "0";
  document.body.append(area);
  try {
    area.select();
    if (!document.execCommand("copy")) throw new Error("copy-unavailable");
  } finally {
    area.remove();
  }
}
async function writeText(text: string) {
  const bridge = window.readerDesktop?.writeClipboardText;
  if (bridge) {
    try {
      await bridge(text);
      return;
    } catch {
      // Fall through to the browser paths when the desktop bridge fails.
    }
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to copySelection.
    }
  }
  copySelection(text);
}
export async function copyText(text: string, successMessage?: string) {
  try {
    await writeText(text);
    if (successMessage)
      toast.success(successMessage, { id: "reader-clipboard" });
    return true;
  } catch {
    toast.error("复制失败，请选择文字后复制。", { id: "reader-clipboard" });
    return false;
  }
}
export async function copyImage(url: string, text: string) {
  try {
    if (window.readerDesktop?.writeClipboardImage) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(response.statusText);
      await window.readerDesktop.writeClipboardImage(
        new Uint8Array(await response.arrayBuffer()),
        text,
      );
      toast.success("已复制图片", { id: "reader-clipboard" });
      return;
    }
    // Pass the blob as a promise so Safari keeps the click's user activation.
    const image = fetch(url).then((response) => {
      if (!response.ok) throw new Error(response.statusText);
      return response.blob();
    });
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": image,
        ...(text && { "text/plain": new Blob([text], { type: "text/plain" }) }),
      }),
    ]);
    toast.success("已复制图片", { id: "reader-clipboard" });
  } catch {
    toast.error("复制图片失败", { id: "reader-clipboard" });
  }
}
