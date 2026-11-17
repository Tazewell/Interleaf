# PDF 滚动热点优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox tracking.

**Goal:** 降低普通 PDF 滚动的主线程样式和无效交互开销，保留选区、批注和视图位置语义。
**Architecture:** 滚动条周期状态独立优化；PDF 交互空闲路径与可选段落锚点扫描独立优化；根任务用固定真实论文 A/B 采样集成。
**Tech Stack:** TypeScript、React、PDF.js、Vitest、浏览器 CPU/Performance 采样。
**Spec:** docs/superpowers/specs/2026-11-17-pdf-scroll-hotpath-design.md（用户已在聊天批准执行）。

## Global Constraints

- Interleaf-dev / dev；基线 f99f2f5。无新依赖，无引擎/清晰度/界面重设，不合并、推送或发版。
- 保留原文件、译文、密钥、书库；没有付费模型请求。
- 修改必须经过 RED→GREEN 和独立审查；主线程时长为诊断证据，不冒充 FPS。

## Review Focus

- 连续滚动跨过隐藏截止时间，不应闪烁或提前隐藏；卸载没有遗留属性/计时器。
- 跨窗口元素及多个滚动容器彼此独立。
- 拖选中滚动、未被 adapter 识别的原生选区、外部输入选区不得错误保留/清除。
- 消费者增减和文档切换不留下旧 rAF；显式导航仍返回正确位置。
- 原页、原版式对照和流式对照都保持现有批注与同步能力。

### Task 1: 滚动条失效范围与周期更新

**Files:** apps/web/src/scrollbars.ts、scrollbars.css，新增 scrollbars.test.ts。
**Interfaces:** installScrollbars(doc: Document): () => void 保持不变。

- [x] 写行为回归：连续滚动不重复属性写入/逐事件计时器；截止时间正确延长、主题显示及多容器/卸载清理。
- [x] 运行并确认预期 RED，局部实现周期状态及低失效成本的滚动条样式，再确认 GREEN。
- [x] 向根任务报告冻结文件及测试，独立审查后分项提交。

### Task 2: 阅读交互空闲快速路径

**Files:** apps/web/src/engines/pdf.ts、pdf-navigation.ts、pdf-annotations.ts、InterleafView.tsx；对应现有或新增 scoped tests。
**Interfaces:** ReaderAdapter/ReaderEvents 公共接口不变，readingAnchor 仍可选，保持流式消费者语义。

- [x] 回归空闲 scroll 不读全局 Selection、不扫描全部批注；真实/拖选中选区及时清除，外部选区保持；hover/点击/显式 clear 行为保持。
- [x] 回归无 readingAnchor 消费者不安排扫描，有消费者的流式阅读继续发送锚点，挂载/消费者更新/销毁正确。
- [x] 确认 RED→GREEN，仅修改有证据的热点。向根任务冻结交付，独立审查后分项提交。

### Task 3: 侧栏状态样式失效隔离（采样后追加）

**Files:** apps/web/src/reader-rounded.css、Workspace.tsx 及其行为测试。

两次 wheel 的 invalidation trace 证实 `.interleaf-panels:has(.assistant-sidebar[data-open="false"])` 被 PDF.js endOfContent / block-hover 后代增删触发；一次重算覆盖 20,029 元素。直接复用 React 侧栏状态表达阅读区圆角，不改变视觉和折叠语义。

- [x] 先写开关状态回归，确认 RED；用已有状态属性替换宽范围 `:has()`，确认 GREEN。
- [x] 原生浏览器复采相同四次滚动，验证全树失效和剩余样式耗时；独立审查、提交。

### Task 4: 真实性能对比与交付

**Files:** 本方案文档；诊断脚本/数据保存在工作区外 task artifact，不提交用户文档或二进制。

- [x] 先采基线，再按相同操作采集修改后的明亮对照阅读，记录视口/DPR/缓存和工具开销；差异不足时继续最小实验。
- [x] 通过阅读专项回归选区、批注入口、模式切换和页码，完成真实浏览器数值采样并提供人工滚动预览。
- [x] 整体独立审查；冻结完整源文件，pnpm typecheck / test / build；整理提交及明确测量限制。

## 交付记录

- Task 1：`5a94ba9`，8 条滚动条回归先 RED 后 GREEN；隐藏 PDF 宿主跳过状态维护，其他容器复用截止时间。
- Task 2：`63d1ea3`，空闲选区/批注快速路径及动态 readingAnchor 消费者；保留真实选区和显式清除行为。
- Task 3：`7e928d8`，侧栏圆角使用现有 right 状态；toolbar、快捷键、拖缩三项 Workspace 行为回归先 RED 后 GREEN。
- 分项和最终整体审查无剩余缺陷；Windows 38 文件 / 320 项专项通过。
- 冻结 935 个源文件，隔离 WSL 逐字节校验，typecheck、完整 test（Go 6 包；Vitest 1,509 通过 / 6 条件跳过）、build 全部退出 0；Windows 前端 build 通过。仍提示已有大 chunk/第三方注释警告。构建前后及产品提交后的源文件字节一致；本交付记录在检查后补充。
- 明亮 SERL 16 页单视口对照，DPR 1.5、1221×763，同样下滚两次/上滚两次：初始样式重算 4.336 秒；Task 1/2 后两次采样 2.087 / 2.063 秒；最终完整刷新后 0.054 秒。条件和限制见设计文档，不作 FPS 或严格速度倍数声明。
- 前后端预览正常，独立副本书库含 5 篇文档。人工体验验收由用户完成；不合并、推送或发布。
