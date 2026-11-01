import bundledReleaseNotes from "../../../../docs/release-notes.json";
export interface ReleaseItem {
  title: string;
  body?: string;
}
export const releaseNotes: Record<string, ReleaseItem[]> = bundledReleaseNotes;
