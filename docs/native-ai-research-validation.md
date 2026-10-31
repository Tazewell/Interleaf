# 原生 AI 与主题研究验证

## 可复现入口

在依赖齐全的 Linux checkout 运行 `pnpm typecheck`、`pnpm test`、`pnpm build`，然后设置 `READER_IMPLEMENTATION_COMMIT` 为被构建源码的完整 Git 提交，运行：

```sh
bash scripts/native-ai-research-acceptance/run.sh /absolute/outside/repository/new-directory
bash scripts/native-ai-research-acceptance/run.sh /absolute/outside/repository/new-directory --checks-only
bash scripts/bilingual-pdf-acceptance/run.sh /absolute/outside/repository/another-new-directory
```

研究脚本拒绝仓库内的 canonical 输出路径，正常执行要求新建测试书库；checks-only 只读取已有证据，不修补缺项。输出包含 `result.json`、真实 Markdown/PDF、非空数据前后快照、处理器信息、模型及公开请求计数。鉴权 token 和合成模型 Key 仅用于任务自有库；不要分享 `server-private.log`、`ready.json` 或私有配置。

模型与公开服务采用确定性夹具。实际构建的 Go 服务经过鉴权 HTTP、真实 SQLite、PDF/EPUB 解析器和模型协议；公开请求通过进程私有 CONNECT 代理及测试 CA，仍执行生产域名解析、公网地址检查、TLS 和限速。代理不转发到互联网，不改系统证书、hosts 或代理。外部 AI CLI 在任务进程 PATH 中设陷阱。

同步页数解析的组合测试使用带插桩的 Go test Server：候选导入走真实 HTTP 和 owner/context 路径，在实际 `pdf.NewReader` 的 ReaderAt 中阻塞。Node 调用真实 `stopLibraryServer`/`migrateLibrary`，实际生产 Go 命令执行 CopyLibrary；断言停止完成前没有目的库或位置文件，释放后无迟到导入并保全非空数据。这不表示生产 cmdmain 也注入了同一阻塞点，更不替代操作系统迁移对话框。生产构建服务的退出另有实际端到端检查。

原有双语验收保留左右并排、逐页交替、公式、字体、最小 9pt、附件与取消断言。所有样本 PDF 必须用标准工具重新打开、Poppler 逐页渲染并人工查看；文本提取不能代替版面检查。研究样本必须同时保留 A/B 冲突和已覆盖/仅摘要不足结论。

## 同名块与归因的 focused 检查

生产 PDF corpus 的 blockId 含 revision 前缀。额外的 `TestResearchSameBareBlockHTTPAttribution` 在两个测试自有原件的有效 fingerprint 缓存中显式设置相同裸 `p1-b1`，同步 FTS，经过真实 loopback 鉴权 HTTP、模型协议、研究完成、报告和来源 GET，核对相反结论与各自 paperId/documentId/sourceId/原文 hash。这是 seeded-corpus 集成，不能称为 ONNX 自然产生碰撞；生产身份规则没有修改。

在 Linux checkout 使用两个绝对仓库外目录（`FOCUSED_OUT` 是新输出目录，`PRIOR_OUT` 是已有完整验收产物）：

```sh
(cd apps/server && READER_TEST_ATTRIBUTION_OUT="$FOCUSED_OUT" go test -race ./internal/reader -run '^TestResearchSameBareBlockHTTPAttribution$' -count=1 -v)
python3 scripts/native-ai-research-acceptance/attribution_test.py
python3 scripts/native-ai-research-acceptance/verify-attribution.py "$FOCUSED_OUT" "$PRIOR_OUT"
python3 scripts/native-ai-research-acceptance/traps_test.py "$PRIOR_OUT" "$FOCUSED_OUT"
node scripts/native-ai-research-acceptance/inspect.mjs "$PRIOR_OUT"
```

逐项归因断言还用于原始 ONNX harness。focused verifier 拒绝互换但各自仍有效的来源引用；对已有 ONNX 产物只读核对历史报告、原件文字/hash 与逐论文绑定，不复活后来 stale/removed 的来源。trap 在最终停止服务并 join 全部自有 worker 后计数，inspector 与实际记录文件交叉核对；负例只写合成记录，不启动外部 Agent。此检查不重跑 40 篇或 PDF 生成。

## 真实网络与质量边界

2026-10-25 06:21 UTC 对 arXiv、Crossref 各执行一次公开小查询 `graph neural networks`，分别请求 1 条，HTTP 200 并解析成功。arXiv 返回 2488 字节 Atom/1 entry；Crossref 返回 381 字节 JSON/1 item。没有重试、模型调用或私人资料。原始状态记录在任务日志 `live-source-smoke.json`，它仅证明该时刻公开端点可用，不能代替上述构建应用链或科学质量验证。

没有提供真实模型 API Key，因此真实翻译、综述与创新性判断质量仍需用户验证。确定性模型只证明协议、覆盖、来源约束、生命周期和保全；联网的有限检索不能证明原创。Linux WSLg 开发预览也不是 Windows/macOS 安装包验收。

## 人工预览步骤

使用任务专属「Interleaf 内置 AI 研究预览」快捷方式，确认打开的是独立样本库。样本连接的测试 Key 已清除后，先在设置填写自己的 API 地址、协议及各用途模型，主动检查文字、工具和图片能力。

1. 打开 Graph 文件夹研究，对比 A/B 相反结论；切换包含子级，检查 5/4 篇范围和原文附件。
2. 查看来源标题、DOI/引用键与摘录；回跳 PDF 页/图块及 D 的 EPUB 章节，删除或修改来源后确认旧来源不可用。
3. 用小预算暂停，再明确继续；确认已有成功单元保留，覆盖清单说明未读内容。
4. 明确允许联网生成想法，阅读查询审计和重合/不足结果；仅在需要时点击候选导入，重复操作检查去重。
5. 修改报告、保存独立修订并导出 Markdown；关闭重开，确认历史和编辑保留。
6. 选 PDF 分别导出左右并排与逐页交替，手工检查公式、图片、选区复制、附件关联和原生保存对话框；中途取消检查没有半成品覆盖原文件。
7. 在独立样本库尝试活动任务时退出、重开和迁移；检查原生目录选择及错误提示。不要使用真实书库进行破坏性测试。

最终机器、命令退出码、提交、警告、产物哈希和逐页观察记录随本任务执行报告保存；2026-10-28最终门禁与独立审查结果见[最终集成记录](superpowers/plans/2026-10-28-native-ai-research-completion.md)；本说明中的人工质量和平台边界继续适用。
