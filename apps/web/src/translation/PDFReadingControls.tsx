import { Tabs, TabsTrigger } from "@interleaf/ui/components/tabs";
import { FileText, TextAlignLeft } from "@phosphor-icons/react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@interleaf/ui/components/select";
import { SlidingTabsList } from "../controls/SlidingTabsList";

export type PDFReadingContent = "source" | "parallel" | "translation";
export type PDFReadingFormat = "flow" | "babeldoc";
const translatedFormats = [
  { value: "babeldoc", label: "原版翻译排版", icon: FileText },
  { value: "flow", label: "流式翻译排版", icon: TextAlignLeft },
] as const;

export function PDFReadingControls({
  content,
  format,
  onContentChange,
  onFormatChange,
}: {
  content: PDFReadingContent;
  format: PDFReadingFormat;
  onContentChange: (value: PDFReadingContent) => void;
  onFormatChange: (value: PDFReadingFormat) => void;
}) {
  const FormatIcon = format === "flow" ? TextAlignLeft : FileText;
  return (
    <div
      className="pdf-reading-mode-controls"
      role="group"
      aria-label="阅读显示"
    >
      <Tabs
        className="reading-mode-tabs"
        value={content}
        onValueChange={(value) => onContentChange(value as PDFReadingContent)}
      >
        <SlidingTabsList aria-label="阅读内容">
          <TabsTrigger value="source">原文</TabsTrigger>
          <TabsTrigger value="parallel">对照</TabsTrigger>
          <TabsTrigger value="translation">译文</TabsTrigger>
        </SlidingTabsList>
      </Tabs>
      {content !== "source" && (
        <Select
          items={translatedFormats}
          value={format}
          onValueChange={(value) => {
            if (value) onFormatChange(value);
          }}
        >
          <SelectTrigger
            className="pdf-reading-format"
            aria-label="排版方式"
            size="sm"
          >
            <FormatIcon
              aria-hidden="true"
              className="size-3.5 text-muted-foreground"
            />
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            align="end"
            alignItemWithTrigger={false}
            className="min-w-44"
          >
            {translatedFormats.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                <item.icon
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
