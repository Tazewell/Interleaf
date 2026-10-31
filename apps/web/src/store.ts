import { create } from "zustand";
import {
  defaultTheme,
  type Document,
  type PaperItem,
  type ReaderTheme,
  type NativeAIConfig,
  type LibraryMode,
  type LibraryPreferences,
  type InterleafLinkTarget,
} from "@interleaf/core";
import { api } from "@interleaf/api";
import { projectPapers } from "./papers/projection";
export const useReaderStore = create<{
  documents: Document[];
  paperItems: PaperItem[] | null;
  paperTrash: PaperItem[];
  active: Document | null;
  theme: ReaderTheme;
  aiConfig?: NativeAIConfig;
  /** Runtime-only invalidation for every consumer of persisted model checks. */
  aiCatalogRevision: number;
  aiModelSaving: boolean;
  libraryPreferences: LibraryPreferences;
  trash: Document[];
  setTrash: (trash: Document[]) => void;
  /** A interleaf:// target waiting for its document to open. */
  linkTarget: InterleafLinkTarget | null;
  setLinkTarget: (target: InterleafLinkTarget | null) => void;
  setLibraryPreferences: (preferences: LibraryPreferences) => void;
  setAIConfig: (config: NativeAIConfig) => void;
  invalidateAICatalog: (snapshot: NativeAIConfig) => void;
  setAIModelSaving: (saving: boolean) => void;
  setDocuments: (documents: Document[]) => void;
  open: (active: Document | null) => void;
  setTheme: (patch: Partial<ReaderTheme>) => void;
}>((set) => ({
  documents: [],
  paperItems: null,
  paperTrash: [],
  active: null,
  theme: defaultTheme,
  aiCatalogRevision: 0,
  aiModelSaving: false,
  libraryPreferences: {},
  trash: [],
  setTrash: (trash) => set({ trash }),
  linkTarget: null,
  setLinkTarget: (linkTarget) => set({ linkTarget }),
  setLibraryPreferences: (libraryPreferences) => set({ libraryPreferences }),
  setAIConfig: (aiConfig) => set({ aiConfig }),
  invalidateAICatalog: (snapshot) =>
    set((state) =>
      state.aiConfig?.connection.url === snapshot.connection.url &&
      state.aiConfig.connection.protocol === snapshot.connection.protocol
        ? { aiCatalogRevision: state.aiCatalogRevision + 1 }
        : state,
    ),
  setAIModelSaving: (aiModelSaving) => set({ aiModelSaving }),
  setDocuments: (documents) => set({ documents }),
  open: (active) => {
    if (!active?.metadataOnly) set({ active });
  },
  setTheme: (patch) =>
    set((state) => ({ theme: { ...state.theme, ...patch } })),
}));
let libraryRevision = 0;
export function forgetLibraryDocuments(ids: string[]) {
  ++libraryRevision;
  const state = useReaderStore.getState();
  state.setDocuments(state.documents.filter((d) => !ids.includes(d.id)));
  if (state.active && ids.includes(state.active.id)) state.open(null);
}
export async function refreshLibrary() {
  const revision = ++libraryRevision;
  const [documents, paperItems] = await Promise.all([
    api.documents(),
    api.papers(),
  ]);
  if (revision === libraryRevision)
    useReaderStore.setState({ documents, paperItems });
}
/** Keep newly allocated keys visible immediately, before the next library poll. */
export async function ensurePaperCitationKeys(ids: string[]) {
  const items = await api.ensureCitationKeys(ids);
  ++libraryRevision;
  const keys = new Map(items.map((item) => [item.id, item.citationKey]));
  useReaderStore.setState((state) => ({
    paperItems:
      state.paperItems?.map((item) =>
        keys.has(item.id) ? { ...item, citationKey: keys.get(item.id)! } : item,
      ) ?? null,
    documents: state.documents.map((doc) =>
      doc.paperId && keys.has(doc.paperId)
        ? { ...doc, citationKey: keys.get(doc.paperId)! }
        : doc,
    ),
  }));
  return items;
}
export async function refreshAIConfig() {
  const before = useReaderStore.getState().aiConfig;
  const config = await api.aiConfig();
  // A concurrent settings save owns its newer snapshot.
  if (useReaderStore.getState().aiConfig === before)
    useReaderStore.getState().setAIConfig(config);
}
export const primaryLibraryMode = (
  preferences: LibraryPreferences,
): LibraryMode => (preferences.primaryMode === "books" ? "books" : "papers");
export const libraryMode = (preferences: LibraryPreferences): LibraryMode =>
  preferences.mode === "books" || preferences.mode === "papers"
    ? preferences.mode
    : primaryLibraryMode(preferences);
export async function loadLibraryPreferences() {
  const preferences = await api.libraryPreferences();
  useReaderStore.getState().setLibraryPreferences({
    ...preferences,
    mode: primaryLibraryMode(preferences),
  });
}
let preferenceWrite = Promise.resolve();
/** Apply locally at once; writes are serialized so the last change wins. */
export function updateLibraryPreferences(patch: Partial<LibraryPreferences>) {
  const state = useReaderStore.getState();
  const next = { ...state.libraryPreferences, ...patch };
  state.setLibraryPreferences(next);
  preferenceWrite = preferenceWrite
    .catch(() => {})
    .then(() => api.saveLibraryPreferences(next))
    .then(() => {});
  return preferenceWrite;
}
let trashRevision = 0;
/** The trash of the current library; older responses never overwrite newer ones. */
export async function refreshTrash() {
  const revision = ++trashRevision;
  const state = useReaderStore.getState();
  const mode = libraryMode(state.libraryPreferences);
  const [documents, paperTrash] = await Promise.all([
    api.trash(mode),
    mode === "papers" ? api.papers(true) : Promise.resolve([]),
  ]);
  const trash =
    mode === "papers" ? projectPapers(paperTrash, documents) : documents;
  if (revision === trashRevision)
    useReaderStore.setState({ trash, paperTrash });
}
/** Open the document a interleaf:// link points to, in its own library. */
export async function openLinkTarget(target: InterleafLinkTarget) {
  let doc = useReaderStore.getState().documents.find((d) => d.id === target.id);
  if (!doc) {
    await refreshLibrary();
    doc = useReaderStore.getState().documents.find((d) => d.id === target.id);
  }
  if (!doc) return false;
  const state = useReaderStore.getState();
  if (libraryMode(state.libraryPreferences) !== doc.library)
    void updateLibraryPreferences({ mode: doc.library }).catch(() => {});
  state.setLinkTarget(target);
  if (state.active?.id !== doc.id) state.open(doc);
  return true;
}

// Cache only safe reproducibility settings in the shell, available after sidecar failure.
useReaderStore.subscribe((state, previous) => {
  if (
    state.theme === previous.theme &&
    state.aiConfig === previous.aiConfig &&
    state.libraryPreferences === previous.libraryPreferences
  )
    return;
  if (typeof window !== "undefined")
    window.interleafDesktop?.diagnosticSettings?.({
      ...state.theme,
      mode: state.libraryPreferences.mode,
      primaryMode: state.libraryPreferences.primaryMode,
      provider: state.aiConfig?.connection.protocol,
      chatModel: state.aiConfig?.models.chat,
      translationModel: state.aiConfig?.models.translation,
    });
});
