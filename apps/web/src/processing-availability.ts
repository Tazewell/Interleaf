import type { Processing } from "@interleaf/core";

export function textIndexAvailability(job: Processing) {
  if (job.phase !== "learning" || !job.textIndex) return undefined;
  const { status, searchablePages, totalPages } = job.textIndex;
  switch (status) {
    case "queued":
      return {
        label: "等待索引",
        description: "可阅读原 PDF，正在等待建立文字索引。",
      };
    case "running":
      return {
        label: "建立索引中",
        description: "可阅读原 PDF，正在建立文字索引。",
      };
    case "ready":
      return {
        label: "可搜索",
        description: `${searchablePages} / ${totalPages} 页可搜索。`,
      };
    case "partial":
      return {
        label: "部分可搜索",
        description: `${searchablePages} / ${totalPages} 页可搜索，其余页面暂无可搜索文字。`,
      };
    case "unavailable":
      return {
        label: "可阅读",
        description: "未提取到文字，仍可阅读原 PDF。",
      };
    case "failed":
      return {
        label: "索引失败",
        description: "可阅读原 PDF，文字索引失败不影响后台版面解析。",
      };
  }
}

export function backgroundLayoutLabel(status: Processing["status"]) {
  if (status === "queued") return "等待版面解析";
  if (status === "failed") return "版面解析失败";
  if (status === "waiting") return "等待 AI 配置";
  if (status === "complete") return "版面解析完成";
  if (status === "paused") return "版面解析暂停";
  return "后台解析";
}
