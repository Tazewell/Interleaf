import { useId } from "react";
import { Progress } from "@interleaf/ui/components/progress";

export function ReadingTranslationProgress({
  label,
  detail,
  percent,
  compact = false,
  decorative = false,
}: {
  label: string;
  detail?: string;
  percent?: number;
  compact?: boolean;
  decorative?: boolean;
}) {
  const detailId = useId();
  const value =
    percent !== undefined &&
    Number.isFinite(percent) &&
    percent >= 0 &&
    percent <= 100
      ? percent
      : undefined;
  return (
    <div
      className={`reading-translation-progress${compact ? " is-compact" : ""}`}
      aria-hidden={decorative || undefined}
    >
      <div className="reading-translation-progress-label">
        <span>{label}</span>
        {value !== undefined && <span>{Math.floor(value)}%</span>}
      </div>
      <Progress
        className="reading-translation-progress-bar"
        value={value ?? null}
        aria-label={label}
        aria-describedby={detail ? detailId : undefined}
        getAriaValueText={(formatted) =>
          value === undefined ? "进行中" : formatted
        }
      />
      {detail && (
        <p id={detailId} className="reading-translation-progress-detail">
          {detail}
        </p>
      )}
    </div>
  );
}
