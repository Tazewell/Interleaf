# 流式 PDF 对照滚动优化计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox tracking.

**Goal:** 单独减少流式对照的原文定位和译文交互重算。
**Architecture:** 导航层可见页定位与 React 交互路径独立修改，保留 ReaderAdapter/ReaderEvents 接口及同步语义。
**Tech Stack:** TypeScript、React、PDF.js、Vitest。
**Spec:** docs/superpowers/specs/2026-11-18-flow-pdf-scroll-design.md

## Global Constraints

- dev / Interleaf-dev，基线 1678197；不合并、推送、发版或改用户数据。
- 不改变画质、引擎、原生选区及存储；不调用模型，无新依赖。
- RED→GREEN、独立审查、完整检查；无真实滚动采样时只报告工作量上界，不能宣称 FPS。

## Review Focus

- 连续垂直布局，混合页高、空白/缺失页面、缩放、窗口变化和动态 block 数组。
- 原文/译文主动输入接管，程序滚动不反向驱动；显式导航仍可发送最终锚点。
- 原页/译文/流式对照/原版式模式切换及文档销毁无旧回调。
- hover/focus 不重算不变内容，真实译文/标注/处理状态更新及引文/重试回调保鲜。

### Task 1: 可见页锚点定位

**Files:** apps/web/src/engines/pdf-navigation.ts、pdf-follow.test.ts 及必要 scoped 导航测试。

- [x] 先写长文深页严格上界、混合页高/跨页 gap、缺失页、数组更新回归并确认 RED。
- [x] 最小可见页定位实现，既有 column/follow/zoom 语义保持，GREEN + 类型检查。
- [x] 独立审查和单项提交。

### Task 2: 译文交互与反向扫描

**Files:** apps/web/src/translation/PDFReadingView.tsx、PDFReadingView.performance.test.tsx、PDFReadingView.test.tsx 及必要小组件。

- [x] 先回归 hover/focus 内容不重算，真实内容/标注/处理更新和最新回调仍生效，确认 RED。
- [x] 提前可选 readingAnchor 消费者的所有权守卫，回归程序跟随不扫描、输入切换恢复与模式切换。
- [x] 最小实现、GREEN + 类型检查，独立审查与单项提交。

### Task 3: 集成验证与预览

- [x] 完整 typecheck/test/build，核对源文件快照和提交，独立整体审查。
- [x] 检查前后端认证预览，明确手动流式对照滚动步骤及实际测量边界，记录结果。
