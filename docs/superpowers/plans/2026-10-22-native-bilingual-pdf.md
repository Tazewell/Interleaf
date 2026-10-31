# 原生双语 PDF 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Interleaf 桌面版用用户配置的 API 翻译并导出并排、交替双语 PDF，保留论文布局和公式，并完成实际文件与生命周期测试。

**Architecture:** Go 冻结原文、版面、译文和 API 配置并管理可取消任务。processor 用 PDF.js 获取物理几何和原始公式像素，独立实现 PDF2zh 的区域段落、公式占位和测宽回排方法，再用 PDF-LIB 和嵌入字体生成可搜索中文、组合原文矢量页面。Electron 只负责原生保存，React 沿用现有导出对话框。

**Tech Stack:** Go/SQLite；TypeScript/PDF.js 6.3.289；pdf-lib 1.17.1；@pdf-lib/fontkit 1.1.1；@napi-rs/canvas；Noto Sans SC (SIL OFL 1.1)；Electron 44.5.1；Vitest。

**Spec:** `docs/superpowers/specs/2026-10-22-native-bilingual-pdf-design.md`。

## Global Constraints

- 中文交互，原生 Interleaf 实现；不引入 Zotero/PDF2zh/PDF2zh_next/BabelDOC 运行时、CLI、服务或排版核心，不复制上游代码。
- 两种模式 `side-by-side`、`alternating`；前者 N→N、宽度 2W+12 pt，后者 N→2N；原文面板不缩小，单个译文页与原页物理尺寸相同。
- 文字层横排 PDF；无文字页必须显式选“保留原文”或阻止继续；无 OCR。表格内部、图内文字、代码、算法、参考文献保留。
- 正文至少 9 pt；测量、碰撞检测、公式复位；不能截断或把失败页静默换成英文。译文无隐藏英文文字对象。
- 字体随应用打包并嵌入 PDF，缺字报错。用户 API 的 URL/key/model 只由现有设置取得，配置冻结；完整响应后验证，无 CLI 回退，不记录密钥。
- 保留原文/阅读译文/批注/笔记；临时文件归本任务；取消、删除、回收、迁移、退出取消并等待子进程；保存取消不挂附件。
- 可选附件必须属于原 PaperItem、角色 translation，不改主附件/引用键，不新建文献；相同内容去重，删除后不得迟到挂附件。
- API 回环鉴权；最终路径仅来自原生选择器。文档和模型文本只作为数据，不执行 HTML/命令，不加载外部资源。
- 完成 `pnpm typecheck`、`pnpm test`、`pnpm build`；不使用浏览器自动化验收界面。使用标准 PDF 渲染核对产物，提供隔离 WSL 预览与人工步骤。

## Review Focus

- CropBox 偏移、UserUnit 与 90/270 度旋转：原文和所有块必须在相同可见物理坐标系（Task 1）。
- 跨栏标题、图题与内联公式相互重叠：素材不能覆盖中文或重复图题，公式占位不丢失（Task 1）。
- API 返回正文但未正常完成、占位被改写、设置中途变化：不能保存半成品或换模型拼接（Task 2）。
- 文件已保存但附件事务失败、文献合并/删除和重复保存：真实结果分别报告且无孤立新文献（Task 2/3）。
- 取消保存、重复点击、组件关闭与慢任务：不会再次保存或产生迟到附件，取消不阻塞阅读（Task 3）。

## 文件职责与公共接口

- `packages/reader-core/src/bilingual-pdf.ts`：数据协议，导出到 core index。`BilingualPDFOptions {layout: 'side-by-side'|'alternating'; fromPage?: number; toPage?: number; translateMissing?: boolean; keepOriginalPages?: number[]}`。
- processor 准备协议 `NativePDFPrepared {version:1; originalSha256:string; revision:string; totalPages:number; pages:NativePDFPage[]; noTextPages:number[]; warnings:string[]}`。页 `{page,width,height,rotation,cropBox:[number,number,number,number],paragraphs:NativePDFParagraph[]}`；段 `{id,blockId,page,source,originalSource,sourceHash,bounds:{x,y,width,height},fontSize,formulas:NativePDFFormula[]}`；公式 `{token,bounds:{x,y,width,height}}`，bounds 均为 PDF.js 可见页面顶左原点的物理点。source 中的 `{v0}` 等在段内唯一；sourceHash 按 export 协议独立哈希，不冒充阅读译文 hash。
- `apps/processor/src/bilingual-pdf/{prepare,formula,layout,compose}.ts`：提取、保护、测宽、排版/组合。公共 `prepareNativePDF({input,layout,fromPage?,toPage?}):Promise<NativePDFPrepared>` 与 `renderNativePDF({input,prepared,targets,output,layout,keepOriginalPages?},progress?):Promise<void>`。targets 为 `Record<paragraphId,string>`，未提供且非明确保留页时报错。
- `apps/processor/src/bilingual-pdf-cli.ts`：`--stage prepare --input PDF --layout MANIFEST --prepared JSON [--from N --to N]`；`--stage render --input PDF --prepared JSON --targets JSON --output PDF --mode side-by-side|alternating [--keep-original 2,4]`。stdout 逐行 JSON `{stage,done,total}`，错误 stderr，非零退出；所有文件路径由 Go 持有。
- `apps/server/internal/reader/bilingual_pdf*.go`：任务、API 翻译和附件。`POST /api/documents/{id}/bilingual-pdf` 创建准备任务，返回 `{id,status,stage,done,total,preflight?,error?}`；`GET .../{job}` 查询；准备结束状态 `awaiting-confirmation`，preflight `{pages,outputPages,missingParagraphs,noTextPages,apiConfigured,warnings}`；`POST .../{job}/start` 接受 `{translateMissing:boolean,keepOriginalPages:number[]}`，转 translating/layout/composing/ready；`DELETE .../{job}` 取消；`GET .../{job}/file` 只提供成功 PDF；`POST .../{job}/attachment` 挂附件，返回 Document。任务 options 页范围/layout 在创建后不改。
- `packages/api-client/src/index.ts` 与 `docs/openapi.yaml`：上述 API 的类型化调用、生成 schema。
- `apps/desktop/main/bilingual-pdf-export.ts`：校验 doc/job id，主进程从固定服务地址下载成功文件，原生选位置、原子写入，返回 `{saved:boolean,fileName?:string}`；拒绝任意 URL/path。`readerDesktop.saveBilingualPDF({documentId,jobId})`。
- `apps/web/src/BilingualPDFExport.tsx`：现有导出弹窗中的原生桌面区域、两个模式/范围/附件/预检/明确翻译开始/真实进度/取消/保存及独立错误反馈。

### Task 1: PDF 准备、公式保护与原生排版组合引擎

**Files:** Create core protocol above; processor `bilingual-pdf/` modules and tests, CLI; `apps/processor/fonts/NotoSansSC.ttf`, `OFL.txt`, `README.md`; modify processor package/build and lockfile. Research notes `docs/native-bilingual-pdf-method.md`.

**Interfaces:** Produces the prepared JSON and render API/CLI exactly above. Go never interprets PDF coordinates or reads arbitrary prepared paths from the renderer. Processor modules import core protocol via relative path.

- [ ] Write failing tests for: 2 pages→2 wide or 4 alternating, selected range, mixed dimensions, nonzero CropBox and rotated/UserUnit pages; Chinese is extractable, font embedded, scripts/annotations not copied. Use programmatically made small PDFs in tests.
- [ ] Write failing tests for protected math token round-trip, unsupported/missing/duplicate token rejection, formulas repositioned inline, measured long CJK/Latin wrapping, 9 pt floor, paragraph/page diagnostics on overflow, no hidden original text on translated page, two columns, captions next to a figure and graphics preserved. Run focused Vitest to capture RED.
- [ ] Implement independent algorithms informed by pinned upstream research below. Use original PDF.js viewport including crop/rotation/UserUnit. Reconstruct the translated page with sanitized 300 DPI background pixels (erase translated block pixels before embedding, then reinsert protected original formula crops) and real selectable text. Skip untranslatable protected layout regions; reject ambiguous destructive overlaps. Keep one page raster at a time; memory/render pixel caps must fail with an explicit page error rather than silently lowering print resolution. Formula/image background has no hidden original PDF text objects. Original panels embed page content as clipped, transformed Form XObjects, stripping active document/page behavior.
- [ ] Use actual font advances and glyph coverage, preserve whitespace and Latin words while allowing oversized-word wrapping; initial body size based on source and >=9 pt, line-height 1.4→1.0 before shrink to 9. Expand only into proven free same-column space, never across assets/neighbor text. Make formula width participate in line fit; no arbitrary LaTeX generated by API.
- [ ] For same-page/same-column footnote blocks whose necessary glyph/erase bounds overlap, combine the connected footnote group into one export-only paragraph before layout: union bounds, reading-order source content exactly once, first blockId, native id/hash covering the whole group. Reject a union that intersects prose/assets/protected regions. Do not modify the manifest or saved reading translations, and do not silently preserve untranslated footnotes.
- [ ] Pin dependencies; obtain Noto Sans SC from google/fonts commit `a85815a42757630ce188fdad368c2dfc444d4773`, file `ofl/notosanssc/NotoSansSC[wght].ttf` (Git blob `fb0637bafbcd804fe32152370a1225990745b4bc`, 17772300 bytes), retain OFL license. Build copies font/license beside compiled CLI. Confirm real fontkit subset round trip; if variable font unsupported, report before changing font selection.
- [ ] CLI writes prepared/output atomically inside passed owned work dir, validates file/JSON/input identity/limits, reports real stages, and exits nonzero for bad geometry/font/token/overflow. No ONNX needed to export an existing layout; preserve normal processor build.
- [ ] Run focused tests plus typecheck in native WSL mirror. Record RED/GREEN evidence and artifact inspection. Inspect diff, stage only task paths, cached check; commit `feat(pdf): add native bilingual typesetting engine`.

Research: PDFMathTranslate/PDFMathTranslate commit `7fd3bb7a2ce22f8e584ceb9d744e2a3a63684987`: `pdf2zh/converter.py` groups by detected layout, recognizes formulas with font/Unicode/subscript cues, substitutes tokens, measures character widths, restores formula glyphs/lines, reduces line height; `high_level.py` supplies region masks and combines original/translations; `translator.py` requires tokens retained. AGPL source is read for algorithm understanding only; implementation is independently written TypeScript and differs in using original formula pixels and hard overflow failure rather than permissive missing tokens.

### Task 2: API 翻译、冻结任务、生命周期与真实附件

**Files:** Create `apps/server/internal/reader/bilingual_pdf.go`, `bilingual_pdf_translation.go`, `bilingual_pdf_attachment.go` and tests; modify server route/state/lifecycle as necessary; `docs/openapi.yaml`, generated `packages/api-client/src/schema.d.ts`, API client/core public job types.

**Interfaces:** Consumes Task 1 CLI/prepared. Produces job routes above. Complete ready job bytes remain owned until cancellation/30 minute TTL/server shutdown. Limit simultaneous jobs to 2 with an actionable busy response; keep state bounded and clean owned directories. In-memory jobs need no DB migration; after restart old jobs are unavailable, unfinished files cleaned safely from dedicated export-temp root.

- [ ] RED tests: authentication/document/type/range validation; awaiting-confirmation preflight; old/partial reading translations excluded; valid source-matched plain translations reused only with no protected formulas or math/Markdown interpretation needed; API missing config causes explicit error only if translation needed; blank/no-text pages require explicit keep list.
- [ ] RED tests: actual mock streaming API respects URL/key/model/protocol from frozen settings (no CLI), completion required, missing/duplicated/unknown tokens fail, untrusted instruction ignored by prompt boundary; settings/source changes mid-job cannot alter frozen input; cancellation stops streaming/processes, garbage/oversized replies bounded. Cover explicit model, configured keyless local API if existing protocol allows it, provider failure without false ready.
- [ ] RED tests: trash/delete/close cancels and joins; TTL/ready file retrieval rejects removed source; attach is atomic and idempotent by content, retains original paper/key/primary, doesn't create a new paper, rejects stale/deleted paper and conflicting owners. Source identity revalidated before ready/attachment. Run focused Go tests to observe RED.
- [ ] Implement create→prepare→awaiting-confirmation→translate→layout/compose→ready, with immutable copied source PDF/layout and existing successful translations/config. Call processor sibling of READER_PROCESSOR using READER_NODE/ELECTRON_RUN_AS_NODE from existing process conventions, isolated working directory and context kill/join. Capture bounded output/errors, no arbitrary renderer paths. Register full running work with beginDocumentTask, cleanup owner paths only.
- [ ] API translation uses existing protocol streamCompletion via API adapter with model resolved once from translation choice then text choice/API model. No CLI fallback; source paragraph requests with placeholders and explicit JSON `{id,target}` output, document data escaped as JSON, validate complete paragraph ids and exact token multiset. Save only validated final export targets, not reading translations. Freeze snapshot revision includes original, layout, targets/options/font/exporter version; deterministic bytes for repeated same snapshot or reuse same ready output.
- [ ] Implement preflight counts/no-text rules and ready download; attachment inserts a real content-addressed Document and translation role into existing original paper in one serialized store operation, never using ordinary import that creates a paper; do not trigger automatic translation of exported attachment. Failed attachment leaves ready file downloadable.
- [ ] Update OpenAPI + generated types + API client in same commit. Run focused Go tests, API types/typecheck; inspect staged diff/check and commit `feat(pdf): manage bilingual export jobs with configured API`.

### Task 3: 桌面保存与导出界面

**Files:** Create `apps/desktop/main/bilingual-pdf-export.ts` and tests; modify main/preload, `apps/web/src/vite-env.d.ts`; create `apps/web/src/BilingualPDFExport.tsx` and lifecycle tests; modify `ExportDocumentDialog.tsx` and tests, minimal style if needed.

**Interfaces:** Consumes Task 2 API and `readerDesktop.saveBilingualPDF({documentId,jobId}):Promise<{saved:boolean,fileName?:string}>`. Main only downloads trusted ready file with server auth and streams to an owned temp alongside native-chosen destination before atomic replacement. Renderer never supplies path/URL/content bytes.

- [ ] RED tests: desktop-only PDF entry, both modes and range/defaults, preflight and API configuration instructions, explicit “翻译并导出” start, original-only no-text acknowledgement, progress and cancel; doc switch/unmount/dispose aborts and deletes job with no late state/save/attach. Existing Markdown/annotation exports still work.
- [ ] RED tests: invalid IPC/sender rejected, save cancel writes nothing, download/write failure preserves destination, duplicate clicks don't save twice, confirmed save only then optional attach, attachment error reported separately after successful save; merged/deleted source no stale attachment. Run focused tests to observe RED.
- [ ] Implement restrained embedded export area using packages/ui primitives, no decorative copy. Attachment option only for PaperItem documents. Use genuine returned stage/counts; current reader remains available, cancel releases task. API URL/key/model edited in existing Settings; no second secret store.
- [ ] Wire native IPC validation and atomic chosen-file save to current authorized window origin, notify cancellation and errors plainly; library move/exit stops running save/download. Hook preload types and retain all existing handlers.
- [ ] Run targeted web/desktop tests and typecheck, inspect staged diff/check; commit `feat(pdf): expose bilingual export and native save`.

### Task 4: 真实 PDF 回归、WSL 预览与使用说明

**Files:** Add meaningful integration fixture generator/acceptance harness under `scripts/` as needed; `docs/native-bilingual-pdf.md` and `docs/native-bilingual-pdf-validation.md`; method note updates only for actual implementation.

**Interfaces:** Executes complete Task 1–3 stack against isolated temporary library and a loopback mock API, never user library or credentials. Generated sample PDFs/PNGs/logs outside Git, final accessible files on E:.

- [ ] Prepare single-column and two-column PDFs with figures/table/captions, display+inline math, footnotes, CropBox/rotation/UserUnit and extreme long translation. For each valid input export both modes, reopen/check dimensions/pages/font/text/no hidden duplicate English on translated panel; render every fixture output page with Poppler (or PDF.js if unavailable), inspect PNGs. Overflow fixture must fail with page/paragraph details and no ready file.
- [ ] Run HTTP/native-save integration with configured mock API: preflight, explicit translate start, poll, native file save function, download byte identity, attach and duplicate attach, cancel and delete. Mark tests using deterministic mocked linguistic output honestly; don't claim a real paid API was used.
- [ ] Run full `pnpm typecheck`, `pnpm test`, `pnpm build` and final focused integration after source changes. Resolve failures with evidence; no browser automation acceptance.
- [ ] Restart isolated WSL preview on final build and supply reachable shortcut and two sample PDFs plus manual export instructions/API setup and limitations. Document exact commands/results and source commit. Inspect and commit docs/harness separately `test(pdf): verify native bilingual exports in WSL`.
