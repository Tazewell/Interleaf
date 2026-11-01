import { contextBridge, ipcRenderer } from "electron";
import type { ProxySettings } from "../../../packages/interleaf-core/src/proxy-settings";
import type { UpdateProgress } from "../../../packages/interleaf-core/src/update-progress";
async function proxyRequest(channel: string, ...args: unknown[]) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (error) {
    // Electron wraps main-process errors with the IPC channel name. Keep
    // validation messages readable in the settings panel.
    throw new Error(
      (error as Error).message.replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        "",
      ),
    );
  }
}
contextBridge.exposeInMainWorld("interleafDesktop", {
  platform: process.platform,
  saveBilingualPDF: (input: { documentId: string; jobId: string }) =>
    proxyRequest("interleaf:save-bilingual-pdf", input),
  cancelBilingualPDFSave: (input: { documentId: string; jobId: string }) =>
    proxyRequest("interleaf:cancel-bilingual-pdf-save", input),
  configureBibliographyExport: (options: unknown) =>
    proxyRequest("interleaf:configure-bibliography-export", options),
  exportDiagnostics: () => ipcRenderer.invoke("interleaf:export-diagnostics"),
  recordDiagnostic: (event: unknown) =>
    ipcRenderer.send("interleaf:diagnostic-event", event),
  diagnosticSettings: (settings: unknown) =>
    ipcRenderer.send("interleaf:diagnostic-settings", settings),
  checkForUpdates: () => ipcRenderer.invoke("interleaf:check-updates"),
  onUpdateProgress: (callback: (progress: UpdateProgress | null) => void) => {
    const listener = (_event: unknown, progress: UpdateProgress | null) =>
      callback(progress);
    ipcRenderer.on("interleaf:update-progress", listener);
    return () => ipcRenderer.removeListener("interleaf:update-progress", listener);
  },
  proxySettings: () => proxyRequest("interleaf:proxy-settings"),
  saveProxySettings: (settings: ProxySettings) =>
    proxyRequest("interleaf:save-proxy-settings", settings),
  checkProxy: (settings: ProxySettings) =>
    proxyRequest("interleaf:check-proxy", settings),
  restart: () => proxyRequest("interleaf:restart"),
  libraryLocation: () => proxyRequest("interleaf:library-location"),
  moveLibrary: () => proxyRequest("interleaf:move-library"),
  commandLine: () => proxyRequest("interleaf:command-line"),
  setCommandLine: (installed: boolean) =>
    proxyRequest("interleaf:set-command-line", installed),
  writeClipboardText: (text: string) =>
    ipcRenderer.invoke("interleaf:clipboard-write", text),
  writeClipboardImage: (data: Uint8Array, text: string) =>
    ipcRenderer.invoke("interleaf:clipboard-write-image", data, text),
  onBeforeClose: (callback: () => Promise<void>) => {
    const listener = () => {
      void callback().then(
        () => ipcRenderer.send("interleaf:flushed", null),
        (error) => ipcRenderer.send("interleaf:flushed", String(error)),
      );
    };
    ipcRenderer.on("interleaf:flush", listener);
    return () => ipcRenderer.removeListener("interleaf:flush", listener);
  },
  setAppearance: (appearance: "light" | "sepia" | "dark" | "system") =>
    ipcRenderer.invoke("interleaf:appearance", appearance),
  findEndNoteLibraries: (id: string) =>
    ipcRenderer.invoke("interleaf:find-endnote", id),
  cancelEndNoteSearch: (id: string) =>
    ipcRenderer.invoke("interleaf:cancel-endnote-search", id),
  chooseEndNoteLibrary: (directory = false) =>
    ipcRenderer.invoke("interleaf:choose-endnote", directory),
  chooseZoteroDirectory: () =>
    ipcRenderer.invoke("interleaf:choose-zotero-directory"),
  importFiles: (library: "books" | "papers", folder = "") =>
    ipcRenderer.invoke("interleaf:import", library, folder),
  importLargePapers: (
    ids: string[],
    library: "books" | "papers",
    folder = "",
  ) => ipcRenderer.invoke("interleaf:import-large", ids, library, folder),
  showDocumentFile: (id: string, type: "pdf" | "epub") =>
    ipcRenderer.invoke("interleaf:document-file", id, type, "show"),
  openDocumentFile: (id: string, type: "pdf" | "epub") =>
    ipcRenderer.invoke("interleaf:document-file", id, type, "open"),
  openExternal: (url: string) =>
    ipcRenderer.invoke("interleaf:open-external", url),
  onOpenLink: (callback: (target: unknown) => void) => {
    const listener = (_event: unknown, target: unknown) => callback(target);
    ipcRenderer.on("interleaf:open-link", listener);
    // Links that arrived before this listener are delivered once.
    void ipcRenderer
      .invoke("interleaf:take-links")
      .then((targets: unknown[]) => targets.forEach(callback));
    return () => ipcRenderer.removeListener("interleaf:open-link", listener);
  },
  onLibraryChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("interleaf:library-changed", listener);
    return () => ipcRenderer.removeListener("interleaf:library-changed", listener);
  },
});
