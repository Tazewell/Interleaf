/** Describe native evidence locations without exposing storage/protocol objects. */
export function researchLocationLabel(value: unknown): string {
  if (!value || typeof value !== "object") return "已读片段（定位详情不可用）";
  const location = value as Record<string, unknown>;
  let label: string;
  if (
    location.type === "pdf" &&
    Number.isInteger(location.page) &&
    Number(location.page) > 0
  )
    label = `PDF 第 ${location.page} 页`;
  else if (
    location.type === "epub" &&
    typeof location.href === "string" &&
    location.href
  ) {
    label = `EPUB 章节：${location.href}`;
    if (
      typeof location.progression === "number" &&
      location.progression >= 0 &&
      location.progression <= 1
    )
      label += `，章节进度 ${Math.round(location.progression * 100)}%`;
  } else if (location.type === "abstract") label = "摘要";
  else if (
    location.type === "html" &&
    Number.isInteger(location.paragraph) &&
    Number(location.paragraph) > 0
  )
    label = `网页第 ${location.paragraph} 段`;
  else return "已读片段（定位详情不可用）";
  if (
    typeof location.start === "number" &&
    typeof location.end === "number" &&
    location.start >= 0 &&
    location.end >= location.start
  )
    label += `，字符 ${location.start}–${location.end}`;
  else if (location.blockId || Array.isArray(location.rects))
    label += "（段落片段）";
  return label;
}
