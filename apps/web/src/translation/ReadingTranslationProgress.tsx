import { Progress } from "@interleaf/ui/components/progress";

export function ReadingTranslationProgress({
  label,
  percent,
  compact = false,
}: {
  label: string;
  percent?: number;
  compact?: boolean;
}) {
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
    >
      <Progress
        className="reading-translation-progress-bar"
        value={value ?? null}
        aria-label={label}
        getAriaValueText={(formatted) =>
          value === undefined ? "进行中" : formatted
        }
      />
      {!compact && value !== undefined && (
        <span
          className="reading-translation-progress-percent"
          aria-hidden="true"
        >
          {Math.floor(value)}%
        </span>
      )}
    </div>
  );
}
