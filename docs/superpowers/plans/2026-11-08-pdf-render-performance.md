# PDF 阅读渲染性能第一轮实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 建立生产构建滚动基线，稳定译文图片布局，避免无关页面的标注和图引用重建。

**Architecture:** 复用现有 PDF.js PDFViewer 和段落同步。性能采集作为独立本地开发脚本运行，不进入正常阅读流程；PNG 尺寸沿现有 block 数据传递，旧文档只读补齐；附加图层按页缓存并正确失效。

**Tech Stack:** React 19、PDF.js 6.3.289、Node、Go、Vitest。

**Spec:** 本聊天已确认的第一轮范围：性能基线、图片尺寸稳定、按页按块更新。完整虚拟化、同步策略重设计、GPU 开关和新发布均不在本轮范围。

## Global Constraints

- 在已隔离的 Interleaf-dev / dev 工作，不合并 main，不推送或发布。
- 保留用户数据和 API 配置，不调用付费模型，不生成假译文覆盖真实译文。
- 遵循现有布局、小公式自然宽度、跨段选区、图引用、批注及阅读位置语义。
- 性能试验使用冻结的 10cf4e2 生产构建与相同文档/视口/缩放；帧回调间隔仅是调度指标，不冒充 Chromium 实际呈现 FPS。
- 使用 CUA 执行浏览器交互；不以浏览器自动化做视觉验收。性能计数与生命周期测试另行验证。
- 独立任务分别提交，作者 Tazewell；全量 typecheck/test/build 通过后交付。

## Review Focus

- 旧 PNG 无尺寸元数据或文件损坏：原文/译文继续可读，不能使 blocks 请求失败。
- 图片高清替换、同 ID 切换文档、解析流更新与卸载：尺寸稳定，旧异步结果不能覆盖新图，无未处理拒绝或失效 URL。
- 原文页 DOM 或同一 textLayer 的文本子树被 PDF.js 替换：旧标注/链接缓存必须失效，未变化页面保留节点。
- 标注编辑、删除、换页与图引用目标出现/消失：只更新相关页，不保留过期链接；点击、选区和重叠标注命中正确。
- 数据采集不记录文本/令牌，不包含冷启动和已隐藏窗口样本；固定条件，公开原始统计和限制。

### Task 1: 可重复的生产滚动基线

**Files:** Create `apps/web/scripts/reading-performance.mjs` and `apps/web/scripts/reading-performance/overlay.js` with `metrics.mjs`; add relevant helper tests and usage documentation with the implementation.

**Interfaces:** Node CLI serves `--web <production-dist>` with loopback proxy `--backend <origin>`, `--port`, `--label`; overlay is enabled only by this benchmark server. It supplies explicit record/stop controls and a JSON report containing frame callback intervals, long tasks, DOM mutations, scroll-event counts, viewport/DPR, and duration. No text, keys, or user-specific page title is collected.

- [x] Test report statistics and filtering of hidden/invalid samples, and server path/proxy boundaries.
- [x] Freeze baseline production assets before Task 2/3; collect a real reading trial using CUA input for original-only, parallel sync-disabled, parallel sync-enabled where feasible.
- [x] Capture equivalent after-change trial. Distinguish diagnostic samples from statistically robust benchmark claims.
- [x] Commit only benchmark scripts/tests/docs; keep actual PDFs, private paths and run results in local artifacts.

### Task 2: 准确图片占位及裁图任务生命周期

**Files:** `packages/interleaf-core/src/index.ts`, `apps/processor/src/layout-worker.ts` and crop tests, `apps/server/internal/interleaf/processing.go` plus a focused PNG metadata helper/test, `docs/openapi.yaml`, generated API schema, `apps/web/src/translation/TranslationText.tsx`, `block-images.ts`, `PDFReadingView.tsx` cache-lifetime hunks and relevant tests.

**Interfaces:** Optional `PDFBlock.imageSize: { width: number; height: number }` denotes actual persisted crop pixel dimensions, including padding. `blockImageCache.url(blockId, width, signal?, sourceKey?)` retains compatibility; at most 2 active and 32 pending high-resolution requests, 16 unused completed entries. Document/engine lifetime owns cache; source changes invalidate only affected entries. Image consumers hold a cancellation lease within a 1000px viewport margin; live URLs are not evicted, and absent IntersectionObserver falls back to unmount cleanup.

- [x] Write failing tests for exact crop dimensions/padding, legacy PNG header backfill, corrupt/missing files and safe rooted paths.
- [x] Add optional dimensions at crop creation; GET blocks fills absent dimensions read-only with bounded PNG-header reads; preserve old manifests.
- [x] Write failing renderer tests: dimensions before load, small formula width, sharp replacement stays in same box, legacy fallback, stale completion after source/doc change and unmount.
- [x] Reserve the real box using pixel dimensions plus explicit aspect ratio; preserve fallback behavior if dimensions unknown.
- [x] Test and implement bounded high-resolution concurrency, cancellation, replacement and stable cache lifetime across unrelated block updates. Do not evict/revoke URLs still used by mounted images merely to impose an LRU limit.
- [x] Run focused processor/Go/web tests and typecheck, review, commit this task independently.

### Task 3: 附加图层按页增量更新

**Files:** `apps/web/src/engines/pdf-annotations.ts`, `pdf-figure-links.ts`, their tests and `pdf.ts` event-wiring hunks.

**Interfaces:** `PDFAnnotationLayer.paint(pageNumber?: number)` and `PDFFigureLinks.repaint(pageNumber?: number)` retain full-refresh callers while permitting PDF.js events to target a page. Cache validity includes page/textLayer identity and content mutations; target availability uses latest block data.

- [x] Write failing tests: unchanged annotation arrays preserve nodes; edit/delete/move changes only affected pages; cleared/replaced page DOM rebuilds correctly; gesture survives refresh.
- [x] Index annotations by page and reconcile only changed marker content, keeping unaffected DOM identities.
- [x] Write failing tests: repeated figure repaint/unchanged blocks preserve link/Text/Range identity; target add/remove/ambiguity and identical-text DOM replacement rebuild correctly; native links and selection stay functional.
- [x] Cache text-layer content versions, ignore self-generated wrapping mutations, and invalidate on real child/character changes.
- [x] Forward pageNumber from pagerendered/textlayerrendered. No broad PDF.js renderer or selection-layer rewrite.
- [x] Run focused engine/integration tests and typecheck, review, commit independently.

## Integration

- [x] Independently review Task 2/3 changes and the whole branch; address concrete correctness issues.
- [x] Verify frozen source bytes with `pnpm typecheck`, `pnpm test`, `pnpm build` in the existing isolated verification clone.
- [x] Rebuild native Windows backend if API metadata changes and production renderer; expose an authenticated preview and retain library data.
- [x] Compare before/after diagnostic trials; report measured results and uncertainty without claiming a guaranteed frame rate.

## Verification Record

2026-11-08：三项任务及独立审查完成。完整 `pnpm typecheck`、`pnpm test --maxWorkers=4`、`pnpm build` 均通过；Go 6 包，Vitest 192 文件、1439 项测试通过，3 文件/5 测试跳过。隔离验证前后 914 个源文件字节一致；验证后只补计划完成状态和提交记录。

生产构建已采集真实双向滚轮诊断。修复了采样窗口漏记跨边界长停顿的问题，并撤回旧采样比较。重新固定视口后，基线重复采样仍出现很大波动，两版均存在长任务；本轮没有建立可靠的提速幅度或实际 FPS 结论。完整数据、排除说明和检查日志保留在本地 `pdf-performance-pass` 产物目录，不进入仓库。

本轮交付的是明确减少重复工作的实现及可复现诊断工具；桌面实际滚动流畅度仍须人工核对，后续根据 Chromium trace 决定是否进一步做译文虚拟化。正常生产预览已恢复，测试书库保留。没有合并 main、推送或发布。
