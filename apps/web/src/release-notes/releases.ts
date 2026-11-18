import bundledReleaseNotes from "../../../../docs/release-notes.json";
export interface ReleaseItem {
  title: string;
  body?: string;
}
export const releaseNotes: Record<string, ReleaseItem[]> = bundledReleaseNotes;

export function releaseNotesSince(version: string, seenVersion?: string) {
  const items = releaseNotes[version] ?? [];
  // The bundled versions are appended in release order.
  const versions = Object.keys(releaseNotes);
  const currentIndex = versions.indexOf(version);
  const seenIndex = seenVersion ? versions.indexOf(seenVersion) : -1;
  const previousVersion =
    seenIndex >= 0 && seenIndex < currentIndex
      ? seenVersion
      : versions[currentIndex - 1];
  const series = version.split(".").slice(0, 2).join(".");
  const earlierItems = previousVersion?.startsWith(`${series}.`)
    ? releaseNotes[previousVersion]
    : [];

  // Only fold notes that are still present at the beginning of this release.
  const cumulative = earlierItems.every(
    (item, index) =>
      items[index]?.title === item.title && items[index]?.body === item.body,
  );
  return cumulative
    ? { items: items.slice(earlierItems.length), earlierItems }
    : { items, earlierItems: [] };
}
