import { useEffect, useRef, useState } from "react";
import { api } from "@interleaf/api";
import type { ReleasePreferences } from "@interleaf/core";
import { toast } from "sonner";
import { ReleaseNotesDialog } from "./ReleaseNotesDialog";
import { releaseNotes, type ReleaseItem } from "./releases";

/** Show notes once after an update, without first-run onboarding. */
export function ReleaseNotesHost({
  ready,
  version,
  hasDocuments,
}: {
  ready: boolean;
  version: string;
  hasDocuments: boolean;
}) {
  const [items, setItems] = useState<ReleaseItem[] | null>(null);
  const preferences = useRef<ReleasePreferences>({});
  const launched = useRef(false);
  const acknowledge = () => {
    preferences.current = { ...preferences.current, seenVersion: version };
    void api
      .saveReleasePreferences(preferences.current)
      .catch((error) => toast.error((error as Error).message));
  };
  useEffect(() => {
    if (!ready || launched.current) return;
    launched.current = true;
    void api
      .releasePreferences()
      .then((saved) => {
        preferences.current = saved;
        if (saved.seenVersion === version) return;
        if (!saved.seenVersion && !hasDocuments) acknowledge();
        else setItems(releaseNotes[version] ?? []);
      })
      .catch(() => {});
  }, [ready, version, hasDocuments]);
  return (
    <ReleaseNotesDialog
      open={items !== null}
      version={version}
      items={items ?? []}
      onClose={() => {
        setItems(null);
        acknowledge();
      }}
    />
  );
}
