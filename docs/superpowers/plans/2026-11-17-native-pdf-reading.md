# 原版式 PDF 对照阅读实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox tracking.

**Goal:** 单 PDF 视口呈现左右原译版式，保留现有阅读能力和书库身份。

**Architecture:** 扩展现有 native PDF renderer 的只读阅读输出；Go 管理独立持久缓存与任务；前端 PDF adapter 处理宽页和原文坐标边界，阅读界面选择该视图。

**Tech Stack:** Go、React、PDF.js、pdf-lib、Vitest。

**Spec:** docs/superpowers/specs/2026-11-17-native-pdf-reading-design.md（用户已在聊天批准）。

## Global Constraints

- 工作路径 Interleaf-dev / dev，基线 8659bb9；作者 Tazewell。不合并 main、不推送、不发版。
- 不调用翻译 API，不解析模型配置，不更改原文件、译文或用户书库附件。无法复用的段落明确保留原文。
- 新 API 全部沿现有 loopback 鉴权；缓存身份包含原文/layout/visible translations/renderer version。
- 保存的 page/原文 rects 仍是原文坐标；右侧不能假冒原文批注或编造 sentence 对齐。
- 原导出路径行为不变，现有 UI primitives、主题、图标和克制布局优先。人工视觉验收，不以浏览器自动化验收外观。

## Review Focus

- 源更新、重译中 previous complete、重启、缺/损坏缓存文件不能显示错误修订。
- 换文档和取消期间完成旧任务不能污染新视图；删除/关闭要加入任务退出。
- 旋转、cropbox、gutter、右侧及跨侧选区不能把宽页坐标持久化到原文。
- 缺译、公式、Markdown、字体缺字、排版溢出必须准确报告且保留原图，不调用模型。
- HTML 译文/源搜索/图引用/已有批注模式切换保留语义，不能假装新视图支持未实现的精确选择。

### Task 1: 阅读专用 PDF 输出及真实几何报告

**Files:** packages/interleaf-core/src/native-pdf-reading.ts (root predeclared contract), index.ts export; apps/processor/src/bilingual-pdf/{compose.ts,engine.test.ts}; bilingual-pdf-cli.ts.

**Interfaces:** renderNativePDF reading-only option `reading?: boolean`, returns NativePDFReadingReport. CLI `--reading true --reading-metadata <path>` writes report with pages (page,width,height,outputWidth,translationOffsetX,paragraphs), paragraph id/blockId/sourceHash/bounds/translated/target, actual translated/original counts and warnings. Default export strict behavior unchanged.

- [x] Add failing real-PDF tests for reading partial targets, preserved original ink, correct 2*w+12 geometry, successful/failed paragraph fits and default strict failures.
- [x] In reading mode only, fit/erase/draw successful supplied targets; missing/unsupported/overflow remains original bitmap, with honest report. Fail structural invalid inputs as before.
- [x] CLI validates safe metadata output path and serializes report; no API or user data access.
- [x] 真实论文回归：仅阅读模式对已知公式字形、文字归属或安全擦除证明失败保留整页并提示；可证明的原段落计数，未知归属不编造。严格导出与结构错误检查保持原行为。
- [x] Focused processor tests and typecheck; task review; coherent commit after freeze.

### Task 2: 独立持久阅读缓存和接口

**Files:** apps/server/internal/interleaf/native_pdf_reading*.go; minimal server route/state lifecycle; docs/openapi.yaml; packages/api-client/src/{index.ts,schema.d.ts}; shared contract export only if Task1 has not done it.

**Interfaces:** NativePDFReadingJob/Manifest in shared contract. POST `/api/documents/{id}/native-pdf-reading` `{}` returns 200 ready cache or 202 job; GET/DELETE `/api/documents/{id}/native-pdf-reading/{job}`; GET `/api/documents/{id}/native-pdf-reading/cache/{key}/file` and `/metadata`. Client methods createNativePDFReading(id,signal?), nativePDFReading(id,job,signal?), cancelNativePDFReading(id,job), nativePDFReadingFileURL(id,key), nativePDFReadingMetadata(id,key,signal?). URL must use existing authenticated transport conventions.

- [x] Failing tests for zero API/config access, same-key dedup, persistent/restart cache hit, invalidation, corrupt/missing cache, cancellation/delete/close joins.
- [x] Key hashes original bytes, exact layout, stable visible translations, renderer version and side-by-side/keep-original policy. Place in existing per-document analysis/cache tree so document deletion covers it. No attachment or translation DB write.
- [x] Freeze input and strictly reuse current compatible reading translations; call processor prepare/render with reading flag. Missing results preserve original paragraph; build metadata from actual report, include PDF SHA/bytes and revisions. Metadata is atomic completion marker.
- [x] Validate current document/revisions before publication and every read; 409 for stale, no live API probes. Cancel and wait subprocess lifecycle. Completed cache independent of memory jobs; retry after failure.
- [x] Add client/schema; focused Go/API tests, review and coherent commit.

### Task 3: 宽页阅读适配及坐标映射

**Files:** new apps/web/src/engines/native-pdf-reading*.ts/tests; minimal pdf.ts optional presentation hooks; InterleafView.tsx descriptor prop if needed. No PDFReadingView.tsx edits (root integration).

**Interfaces:** Extend `PDFReaderAdapter(container,events,nativeReading?: NativePDFReadingDescriptor)`; export descriptor `{ metadata: NativePDFReadingManifest; fileURL: string; translations: TranslationBlock[] }` from `engines/pdf-native-reading.ts`. InterleafView optional nativeReading prop reopens on metadata.cacheKey change and uses third constructor arg only for PDF. Public locations/TOC/pagecount source identity; exact persisted HTML TranslationLocation only for matching manifest target. No second hidden PDFReaderAdapter; original raw PDF.js metadata proxy is allowed.

- [x] Test geometry forwards/inverse, source highlights, right/left/cross-side selection, paragraph navigation, page boundaries, stale descriptor teardown.
- [x] One PDF.js viewer loads derived PDF; restore original outline/source source identity, map events and location navigation. No second hidden live PDF viewer. Can load original PDF metadata proxy if necessary, destroy it on exit.
- [x] Derive right selections only from exact known target and sourceHash; unsupported cross-side selection remains truthful page/text and cannot create false precise marks. Existing right annotations rendered by legitimate target anchors, not source rects. Explain capabilities accurately.
- [x] Tests integration with native PDF adapter, existing selection/annotation/search; task review and coherent commit.

### Task 4: 阅读模式、任务界面和完整集成

**Files:** PDFReadingView.tsx/tests, new NativePDFReadingView.tsx/tests and hook; existing translation CSS minimal scoped additions; docs user-facing behavior if necessary.

- [x] Test cache/generate/poll/retry/cancel and stale doc result, zero implicit translate, switching/return page preservation, mode regression.
- [x] Current 对照 becomes native wide view; preserve old behavior as 流式对照 and HTML 译文. Stable existing segmented controls, truthful progress and original-retained counts, cancellation and failure recovery. No unprompted visual redesign.
- [x] Native adapter search/prepareAnnotation/focus must bypass HTML/source proxy assumptions. Native loading never writes fake reading location. Preserve same document AI context, page navigation and source identity.
- [x] Independent whole-branch review, full pnpm typecheck/test/build on exact frozen source; authenticated preview with existing library preserved, manual verification instructions.

## Integration Boundaries

Task1 owns processor and contract export; Task2 owns Go/API schema/client; Task3 owns pdf engine/InterleafView; root owns UI/plan. Shared core contract shape is frozen above, changes must be coordinated. Any partial target counts come from actual rendered report, not planned target count. No task may silently relax export validation or call model providers.

Task3 recon ruling: exact native target joins stored sentences with spaces, whereas HTML annotation offsets join with no separators. Selection matching must normalize whitespace/soft hyphens while preserving UTF-16 offset mapping and reject ambiguous matches. Kept paragraphs cannot be indexed as translated. Derived PDF strips original annotations/outline, so original proxy supplies TOC/context/citations and safe link overlays where necessary.
