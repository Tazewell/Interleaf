import { FormulaRow } from "./FormulaRow";
import type { PDFBlock, Processing, TranslationBlock } from "@reader/core";
import { blockImageURL } from "@reader/api";
import { Button } from "@reader/ui/components/button";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ReadingLinkNavigation } from "../reading-links";
import { ErrorBoundary } from "../ErrorBoundary";
const FormulaFragment = lazy(() => import("./FormulaFragment"));
const Markdown = lazy(() =>
  import("../chat/MessageMarkdown").then((module) => ({
    default: module.MessageMarkdown,
  })),
);
function MessageMarkdown({
  content,
  blockId,
  onCitation,
}: {
  content: string;
  blockId?: string;
  onCitation?: (blockId: string, label: string) => void;
}) {
  return (
    <Suspense fallback={<span>{content}</span>}>
      <ReadingLinkNavigation.Provider value={onCitation}>
        <Markdown
          content={content}
          citationBlockId={onCitation ? blockId : undefined}
        />
      </ReadingLinkNavigation.Provider>
    </Suspense>
  );
}

/**
 * Layout crops are rasterized with the whole page, so figures look soft once
 * shown at full width. After the lazy crop loads, a vector render at the
 * displayed device-pixel width replaces it without changing the layout.
 */
function BlockImage({
  src,
  alt,
  render,
}: {
  src: string;
  alt: string;
  render?: (width: number) => Promise<string>;
}) {
  const [sharp, setSharp] = useState<{ url: string; width: number }>();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <img
      className="translation-image"
      src={sharp?.url ?? src}
      width={sharp?.width}
      alt={alt}
      loading="lazy"
      onLoad={(event) => {
        if (sharp || !render) return;
        const image = event.currentTarget;
        const width = image.naturalWidth;
        const pixels = Math.min(width, image.clientWidth || width);
        render(Math.ceil(pixels * (window.devicePixelRatio || 1)))
          .then((url) => {
            if (mounted.current) setSharp({ url, width });
          })
          .catch(() => {});
      }}
    />
  );
}

export function TranslationText(props: TranslationTextProps) {
  return (
    <ErrorBoundary
      resetKey={props.translation}
      fallback={<p className="translation-warning">此段无法显示</p>}
    >
      <TranslationContent {...props} />
    </ErrorBoundary>
  );
}
type TranslationTextProps = Parameters<typeof TranslationContent>[0];
function TranslationContent({
  block,
  translation,
  documentId,
  retry,
  paused = false,
  processing,
  linked = [],
  formulaNumber,
  onCitation,
  imageURL,
  renderImage,
}: {
  // PDF blocks and EPUB paragraphs share these fields.
  block: Pick<PDFBlock, "id" | "label" | "text" | "image" | "caption"> &
    Partial<PDFBlock>;
  translation?: TranslationBlock;
  documentId: string;
  /** Requests this block; also used for blocks that were never requested. */
  retry: () => void;
  paused?: boolean;
  processing?: Processing;
  linked?: number[];
  formulaNumber?: string;
  onCitation?: (blockId: string, label: string) => void;
  /** EPUB images come from the publication rather than the PDF asset store. */
  imageURL?: string;
  /** Replaces the low-resolution layout crop with a render sized for display. */
  renderImage?: (blockId: string, width: number) => Promise<string>;
}) {
  const formula = ["display_formula", "inline_formula"].includes(block.label);
  const idle = translation?.status === "idle";
  const status = processing?.translating?.status ?? processing?.status;
  const halted =
    paused ||
    processing?.enabled === false ||
    processing?.status === "paused" ||
    status === "paused";
  const pendingLabel = halted
    ? "翻译已暂停"
    : status === "failed"
      ? "翻译已停止"
      : status === "waiting"
        ? "等待配置翻译模型"
        : status === "queued"
          ? "等待翻译"
          : "正在翻译中…";
  const asset =
    !!block.image ||
    ["algorithm", "table", "chart", "image"].includes(block.label);
  const image = block.image ? (
    <BlockImage
      key={`${block.id}:${block.image}`}
      src={imageURL ?? blockImageURL(documentId, block.id, block.image)}
      alt={block.caption || block.text || block.label}
      render={
        imageURL || !renderImage
          ? undefined
          : (width) => renderImage(block.id, width)
      }
    />
  ) : null;
  const formulaFallback = image || <MessageMarkdown content={block.text} />;
  if (
    formula &&
    translation?.status === "complete" &&
    translation.formulaMarkdown
  ) {
    return (
      <Suspense
        fallback={
          <FormulaRow number={formulaNumber}>{formulaFallback}</FormulaRow>
        }
      >
        <FormulaFragment
          content={translation.formulaMarkdown}
          fallback={formulaFallback}
          number={formulaNumber}
        />
      </Suspense>
    );
  }
  if (formula)
    return (
      <div>
        <FormulaRow number={formulaNumber}>{formulaFallback}</FormulaRow>
        {block.image && (
          <div className="translation-formula-status" role="status">
            {translation?.status === "failed" ? (
              <>
                <span>{translation.error || "公式转换失败"}</span>
                <Button variant="ghost" size="sm" onClick={retry}>
                  重试公式
                </Button>
              </>
            ) : idle ? (
              <>
                <span>保留原图</span>
                <Button variant="ghost" size="sm" onClick={retry}>
                  转换公式
                </Button>
              </>
            ) : (
              <span>
                {halted ||
                status === "failed" ||
                status === "waiting" ||
                status === "queued"
                  ? pendingLabel
                  : "公式转换中…"}
              </span>
            )}
          </div>
        )}
      </div>
    );
  const preserve =
    [
      "reference",
      "reference_content",
      "display_formula",
      "inline_formula",
      "formula_number",
      "header",
      "footer",
      "number",
    ].includes(block.label) ||
    (asset && !block.caption);
  return (
    <>
      {image}
      {preserve ? (
        !asset && (
          <MessageMarkdown
            content={block.text}
            blockId={block.id}
            onCitation={onCitation}
          />
        )
      ) : translation?.status === "complete" ? (
        <div className="translation-sentences">
          {translation.sentences.map((sentence, i) => (
            <div
              key={i}
              className="translation-sentence"
              data-sentence={i}
              data-linked={linked.includes(i) || undefined}
            >
              <MessageMarkdown
                content={sentence.target}
                blockId={block.id}
                onCitation={onCitation}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="translation-pending" role="status">
          <span>
            {translation?.status === "failed"
              ? translation.error || "此段翻译失败"
              : idle
                ? "未翻译"
                : pendingLabel}
          </span>
          {(translation?.status === "failed" || idle) && (
            <Button variant="ghost" size="sm" onClick={retry}>
              {idle ? "翻译此段" : "重试此段"}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
