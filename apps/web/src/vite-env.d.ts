/// <reference types="vite/client" />

interface Window {
  interleafDesktop?: {
    platform: string;
    saveBilingualPDF?: (input: {
      documentId: string;
      jobId: string;
    }) => Promise<{ saved: boolean; fileName?: string }>;
    cancelBilingualPDFSave?: (input: {
      documentId: string;
      jobId: string;
    }) => Promise<void>;
    configureBibliographyExport?: (options: {
      folder: string;
      includeChildren: boolean;
      mode: "bibtex" | "biblatex";
    }) => Promise<import("@interleaf/core").BibliographyExport | null>;
    exportDiagnostics?: () => Promise<boolean>;
    recordDiagnostic?: (
      event: import("../../../packages/interleaf-core/src/diagnostics").DiagnosticEvent,
    ) => void;
    diagnosticSettings?: (settings: unknown) => void;
    checkForUpdates: () => Promise<void>;
    onUpdateProgress?: (
      callback: (
        progress: import("@interleaf/core").UpdateProgress | null,
      ) => void,
    ) => () => void;
    proxySettings?: () => Promise<import("@interleaf/core").ProxySettingsState>;
    saveProxySettings?: (
      settings: import("@interleaf/core").ProxySettings,
    ) => Promise<import("@interleaf/core").ProxySettingsState>;
    checkProxy?: (
      settings: import("@interleaf/core").ProxySettings,
    ) => Promise<import("@interleaf/core").ProxyCheckResult>;
    restart?: () => Promise<void>;
    libraryLocation?: () => Promise<string>;
    moveLibrary?: () => Promise<boolean>;
    commandLine?: () => Promise<import("@interleaf/core").CommandLineStatus>;
    setCommandLine?: (
      installed: boolean,
    ) => Promise<import("@interleaf/core").CommandLineStatus>;
    writeClipboardText: (text: string) => Promise<void>;
    writeClipboardImage: (data: Uint8Array, text: string) => Promise<void>;
    setAppearance: (
      appearance: "light" | "sepia" | "dark" | "system",
    ) => Promise<void>;
    /** Resolves with long papers that need the reader's confirmation. */
    findEndNoteLibraries?: (id: string) => Promise<{
      candidates: { path: string; name: string }[];
      timedOut: boolean;
    }>;
    cancelEndNoteSearch?: (id: string) => Promise<void>;
    chooseEndNoteLibrary?: (directory?: boolean) => Promise<string | null>;
    chooseZoteroDirectory?: () => Promise<string | null>;
    importFiles: (
      library: "books" | "papers",
      folder?: string,
    ) => Promise<Array<{ id: string; name: string; pages: number }>>;
    importLargePapers: (
      ids: string[],
      library: "books" | "papers",
      folder?: string,
    ) => Promise<void>;
    showDocumentFile: (id: string, type: "pdf" | "epub") => Promise<void>;
    openDocumentFile: (id: string, type: "pdf" | "epub") => Promise<void>;
    openExternal: (url: string) => Promise<void>;
    onOpenLink?: (
      callback: (target: import("@interleaf/core").InterleafLinkTarget) => void,
    ) => () => void;
    onBeforeClose: (callback: () => Promise<void>) => () => void;
    onLibraryChanged: (callback: () => void) => () => void;
  };
}
