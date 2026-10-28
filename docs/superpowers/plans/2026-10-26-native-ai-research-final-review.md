> 历史报告：下列2026-10-26三个阻断已在2026-10-28修复并复审关闭，最新状态见[最终集成记录](2026-10-28-native-ai-research-completion.md)。原报告及当时裁定保留，不作为当前待办或重复授权要求。

# 内置 AI 研究：最终限定复审及未关闭项

2026-10-26，产品源码 `f0ae338b895196323a6d44259e22089a9d80cf22`。独立复审仅覆盖统一修复范围 `d8071c3..f0ae338`，不是第二次完整分支审查。结论为 **4 项关闭、3 项 Important 未关闭、0 Critical**；Task 11 和整体目标尚未完成。

## 控制者裁定与后续修复范围

1. I1 保持 Important：常见中英文原创概率仍绕过校验。下一轮须同时验证合法科学百分比可以成功、报告自由文本中的上述概率句式不能保存为成功；不能恢复对所有百分比的拒绝。若本裁定误判，会增加语义校验的修复和验收工作，但不因此接受未满足的约束。
2. I3 保持 Important：摘要区域丢失结构后，其 Methods/Results 与正文不可区分。下一轮先以真实 HTTP 结构化摘要制作反例，再确认正文身份或保守降级；保留真正全文的正例及旧缓存不升级约束。该项当前是源码推导，不能说成已执行的 HTTP 反例。若误判，会延迟可读正文的认证并增加兼容测试。
3. I7 保持 Important：超时或失败的停止 Promise 会永久阻止后续退出。下一轮须测试晚到 close、非零退出、再次退出/重启/迁移的不同结果；不得恢复硬杀或提前开始迁移。若误判，会增加异常收尾状态的实现和生命周期验证成本。

当前执行技能限定“一次统一修复 + 一次限定复审”，已执行完；没有自动启动第二轮修复。等待用户明确授权后按上述三个缺口继续。保留分支、工作树、独立审计目录和已有产物；不合并、推送、发布或删除任何审计材料。

## 已执行验证与边界

- 最终产品的 `pnpm typecheck`、`pnpm test`、`pnpm build` 均 exit 0；Go 全套通过；Vitest 170 文件通过、3 文件跳过，1225 测试通过、5 跳过。警告与跳过保留原记录，未全局屏蔽。
- 实际构建服务验收 20 项通过，40 篇全范围、69 次受控模型调用、外部 Agent trap 0、非空数据保全；不能覆盖本次新发现的三个边界，也不能证明真实科学质量。
- 最终研究样本 PDF 6 页已全部实际查看并重开；既有双语 4 PDF 共 15 页保持原验收。最终输出目录为 `E:/WSL/reader-native-ai-final-fix-acceptance-v2`；完整根检查与字节绑定为 `E:/WSL/reader-native-ai-logs/final-review-fix/v2`。
- 可用开发预览和人工步骤见[交接记录](2026-10-24-native-ai-research-handoff.md)与[验证说明](../../native-ai-research-validation.md)。真实模型质量、Windows/macOS 原生界面与安装包仍在已披露的人工验收边界内。
- 下文原文来自同一工作树 `.superpowers/sdd/2026-10-22-native-ai-research/final-scoped-review.md`；定向探针 `.cjs` / `.go` / `.log` 保留同目录。原文指出 I1/I7 是实际生产代码 seam 探针，I3 是源码推导；未为复审重跑绿色全套检查。

## 独立复审原文


**I1. 普通科学百分比与原创性概率的语义边界 — NOT ADDRESSED（Important 残余）。** [research_novelty.go:17](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/server/internal/reader/research_novelty.go:17) 已放行准确率、置信区间及数据划分百分比，原误拒反例被修复；但替换后的守卫只覆盖相邻词形，漏掉常见的中文“原创性”和完整概率句式。实际 Go 正则定向探针得到 `原创性概率95%`、`该方法有95%的概率是原创的`、`The probability of originality is 95%` 均 `rejected=false`；对照 `原创概率95%`、`This idea is 100% novel` 均为 true，合法 `Compare accuracy gains of 5% with a 95% confidence interval` 为 false。两处成功结构验证仍只通过这个 helper 拒绝原创保证/概率：[research_ideas.go:113](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/server/internal/reader/research_ideas.go:113)、[research_novelty.go:31](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/server/internal/reader/research_novelty.go:31)。因此把上述句子放在合法 idea/novelty 的自由文本字段中，不会触发该语义守卫；这不是要求正则识别任意语言，而是常见中英文原要求被绕过。现有 `TestResearchIdeasScientificPercentages`/`TestResearchOriginalityGuard` 的实际 `i1-green.log` EXIT0 支持已修正的案例，没有覆盖这些句式。探针只运行实际正则，不声称执行了一次真实模型查新或完整 validator fixture。需保留合法科学百分比，同时覆盖这些常见概率语义，不能将本项视为关闭。

**I2. 保留会话窗口、分批综合、续做和跨批来源 — ADDRESSED。** [research_reports.go:183](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/server/internal/reader/research_reports.go:183) 将初始输入预算与压缩时最新 user group 的保留半窗一致；[research_reports.go:274](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/server/internal/reader/research_reports.go:274) 对本地、在线事实统一递归缩小片段，按 rune 保留全部文本及来源/原生位置；[research_reports.go:338](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/server/internal/reader/research_reports.go:338) 累积已提供来源，保留原会话和逐批检查点窗口。未清空必需历史、增加模型窗口或取前 N 篇。实际模型调用仍经 `ReserveCall: a.reserve`（371），压缩保留预算见 [api_conversation_compact.go:119](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/server/internal/reader/api_conversation_compact.go:119)；压缩调用亦有 reserve/usage，成功检查点和最终报告仍走 owner/snapshot/current generation/source validation（390、447；具名核对 `research_evidence.go:151`）。实际 `i2-red2.log` 的原错误是“本轮输入超过可用上下文，未截断原文”；`i2-final-green.log` 及最终追加的 `i2-online-green.log` 均 EXIT0，后者实际记录 48 model requests / 24 compactions / 24 sections / 12 near-retained-window batches，同会话两次运行、预算暂停恢复及已完成检查点未重放；在线中文 42,014 UTF-8 bytes / 14 sections / 1 authorized fetch 全部送达。测试和源码能证明工程覆盖及引用/预算/恢复机制，不能证明真实模型一定做出高质量科学综合。问题和来源描述本身无法放入最小保留窗口时仍明确失败，此边界已披露。

**I3. HTML 载体与全文资格分层 — NOT ADDRESSED（Important 残余）。** [research_novelty.go:20](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/server/internal/reader/research_novelty.go:20) 不再无条件把 `remote-html` 当全文，缺少 `contentLevel` 的旧缓存不会自动升级；remote cache 的 owner/version/protocol/result hash/原始 evidence 精确比较仍在，未发现此次修复复活失效缓存。但新正文判定 [public_http.go:462](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/server/internal/scholar/public_http.go:462)、[public_http.go:518](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/server/internal/scholar/public_http.go:518) 在 `PublicText` 已丢失 DOM 容器和标题层级后，只检查 Methods 与 Results 后各有至少 160 rune；遇到 Abstract 只清空当前 section，随后 Methods/Results 又立即进入正文状态。因此普通结构化摘要 `<section class="abstract"><h2>Abstract</h2><h3>Methods</h3><p>{至少160字摘要方法}</p><h3>Results</h3><p>{至少160字摘要结果}</p></section>`，只要没有所列付费/登录短语，就会把这两段标为全文。它与当前接受的正文 fixture 在分类器眼中具有同样的行结构。此为直接源码路径推导，未另跑反例或访问真实出版网站。等级经 [research_remote.go:424](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/server/internal/reader/research_remote.go:424) 写入 location，再满足 novelty 的重合/方法差异全文门槛（research_novelty.go:76、86、103）；所以仍然存在摘要冒充全文的原缺陷。`i3-final-green.log` EXIT0 和 `TestResearchRemoteHTMLContentQualification` 的短摘要/登录页/正文/旧记录对照成立，但其摘要负例没有结构化 Methods/Results。需要在丢失结构前保守区分摘要区域与实际正文，或在无可确认正文身份时保持 unconfirmed。

**I4. 安全、只读、可追溯 Markdown 来源导出 — ADDRESSED。** [research_export.go:16](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/server/internal/reader/research_export.go:16) 生成稳定的文内 source anchors 和可读附录，校验 source/run/topic/snapshot、当前文献/文档/原文 hash 或既有远端缓存，输出标题、引用键、PDF 页/块、EPUB href/progression、远端公开 URL/DOI/获取时间/hash/摘录；失效/删除来源保留历史引用并明确不可核验。具名追踪 `cachedPageImage`（document_page_images.go:39）、`validateResearchRemoteEvidence`（research_remote.go:302）、`validateCandidateLocalEvidence`（research_candidate_local.go:49）均没有隐式下载/解析准备；本地校验使用只读文件/数据库，事务仅 rollback。用户历史版本不修改。`research_reports.go:617` 先惰性化 HTML、普通链接、图片及 reference-style brackets，再由受控来源恢复锚点；公开 URL 通过 PublicDisplayURL 去除 query/fragment/用户信息，并编码可破坏 Markdown destination 的字符。实际 `i4-final-green.log`、`i4-reference-green.log` EXIT0，覆盖完成报告及 trash 后历史可读、SQL total_changes/model count 不增、远端无再次 fetch 与引用式链接负例。最终 v2 导出/QA 证据记录 13 anchors 对应 13 appendix headings；本次没有重渲染或重新视觉验收。此处链接是导出文档内的可读出处，不宣称新增 PDF 点击后跳入 app 的能力。

**I5. 工具能力不足时的受控文字研究 — ADDRESSED。** [ResearchPanel.tsx:71](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/web/src/research/ResearchPanel.tsx:71) 只按缺连接/模型或 `text === false` 阻断，tools unsupported/failed 显示受限文字模式而允许用户启动；[research_cards.go:174](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/server/internal/reader/research_cards.go:174) 既有受控文字读取路径继续承担无工具模型的卡片生成；composition 在 research_reports.go:204 显式关闭 Tools/Vision，validator 不广告工具。实际 `i5-green.log` 为 13 tests PASS，后续 `i6-green.log` 为 16 tests PASS；新的 UI 回归实际调用 store create/start，而非只测试按钮文案。没有声称模型获得它不支持的工具/视觉能力；真实配置或文字能力不可用仍阻断。

**I6. 确定未创建的拒绝与不确定传输结果 — ADDRESSED。** [transport.ts:6](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/packages/api-client/src/transport.ts:6) 保留 HTTP status；[research_routes.go:35](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/server/internal/reader/research_routes.go:35) 只在 create 返回空身份时发出 400 + `research_create_rejected`。具名检查 create 的持久化边界：新 run ID 在任何 run INSERT 前分配，已有记录读取失败保持 existing ID（research_jobs.go:168），分配后错误保守维持 uncertain；事务 commit 不会返回空身份。前端 [research-session.ts:402](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/web/src/research/research-session.ts:402) 同时要求 typed RequestError/status/code 才清除 uncertain、保留草稿并移除未保存问题；新 POST 仍只由新的明确用户动作触发。断连/500/其他模糊结果保留只读 GET 恢复，不自动重放付费操作。`ResearchChat.tsx:27` 将拒绝草稿恢复到输入框。实际 `i6-green.log` EXIT0（16 tests，真实 transport 三种响应）、`i6-server-final-green.log` EXIT0 以及源码覆盖原 URL/网络权限拒绝；不把服务器的所有 400 或所有 catch 当确定未创建。

**I7. 普通退出、异常、启动失败、重启和迁移的 EOF/close/join — NOT ADDRESSED（Important 残余）。** [index.ts:69](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/desktop/main/index.ts:69)、[index.ts:872](C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/apps/desktop/main/index.ts:872) 已把正常退出/renderer crash/destroyed/startup-failure/迁移接入 EOF，并在 spawn 即观察 close，消除了普通退出 `child.kill()` 和 exitCode 先更新就提前成功的问题。正常路径由 `i7-final-green.log`（18 PASS）和 v2 `preview-shutdown.json` 支持：owned Electron4026 → Go4097，Go先退出0.512s、Electron0.634s exit0，discovery删除。但是 stopOwnedServer 把 rejection 永久缓存到 `serverStop`；before-quit catch（892）既不重新等待 close，也不清理 `quitJoin` 或处理已经结束的子进程，而 `quitJoined` 始终 false。之后任何 quit 都 preventDefault 并因已有 quitJoin 跳过处理。定向探针直接抽取当前生产 stop helper、stop owner 和 before-quit handler，使用 fake timer/ChildProcess seam：①触发30秒超时后发 `close(0)` 再次 quit，得到 EOF1、childClosed=true、exits0、relaunch0、quitJoined=false；②已 `exitCode=1` 的子进程发 close 后再次 quit，仍 exits0。第二种会影响 Go 启动失败或意外退出后的桌面收尾；第一种会把稍慢但最终成功的清理变成永久无法退出。应用可在无窗口情况下继续持有单实例锁，用户只能外部强制结束，故为 Important。不要取消数据保护或恢复硬杀；失败可以取消迁移/重启，但必须把“清理成功/失败”与“进程已 close，可以结束桌面”区分，或保留可恢复的继续等待状态。探针不是完整 Electron UI 或 Windows 安装器验收；现有测试只有 helper 超时拒绝和 main 延迟成功 close，没有覆盖迟到 close 后再次 quit。

## New Breakage in the Fix Diff

- **Important — I1 的守卫放宽引入常见原创概率句式漏检**，research_novelty.go:17。原实现对任意百分比都会拒绝，这些输入此次新获准；与 I1 残余合计一项，不重复计数。
- **Important — I7 失败的退出 Promise 永久锁死退出**，index.ts:69、880–899。此前普通退出虽有强杀/join问题，但不会因该新缓存状态而在子进程已 close 后永久拒绝退出；与 I7 残余合计一项，不重复计数。
- **Critical：0。其他新增 Important/Minor：本限定 diff 中未确认。** I3 是原全文误认证缺陷未完整修复，单列为原 finding 残余，不重复称作第四项。

## Out-of-Scope Observations

- 原 whole-branch-review.md 的 **M1 测试/构建警告噪声**继续按 Ruling15 延期。此次未清理、未屏蔽 stderr、未因它扩展审查或重跑绿色门禁。
- 没有新增范围外产品发现；本报告不重新评价整分支其他 99 commits/350 files、既有15页双语 PDF、真实科学质量或未实际验证的平台。

## Checks and Evidence Boundary

- 复审固定范围：`d8071c38093c066d8ab1ec2a05aa63f2c31f1ea3..f0ae338b895196323a6d44259e22089a9d80cf22`。一次分段读取标准包 `review-d8071c3..f0ae338.diff`（11 commits、24 paths、提供的包为95311 bytes）；已读原七项 Important、final-fix-brief、DONE final-fix-report、READY context。包外仅追踪上述具名调用的预算/owner/缓存只读/停服边界。
- 实际读取 durable logs 根 `E:/WSL/reader-native-ai-logs/final-review-fix` 下各项 covering green、I2原失败/在线失败及相关输出，以及 `v2/final-{typecheck,test,build}.log` 的实际 EXIT0、`v2/acceptance-final.log` 的20 PASS、`v2/preview-shutdown.json`、`v2/final-evidence-binding.json`。最终测试实际为 Go reader63.414s、Vitest170 passed files/3 skipped files、1225 passed/5 skipped tests。上述为实现方已执行的真实日志核对，**本复审没有重跑这些命令**。
- v2 evidence binding 对应 f0ae338 / 914 tracked files / 10 harness files；接受的 server hash `71cae391241cfdb2150a50e385367a5e43e482b2d9440694bbc927a6df11a472`；PDF hash `838634c39b1eda3f08151599a75d8090de41a9bd9212bf11a840d90a82b33111`、Markdown hash `4f1de452b22f2e91d41bc44b2e8877d7138dc6b20dc1cb6dfd7dd4db620273c1`。69 controlled model calls、arXiv9/Crossref7 controlled requests、40篇覆盖的既有验收是工程证据，没有作为 I1/I3/I7 未覆盖边界的豁免。
- 本次唯一新增执行：`node .superpowers/sdd/2026-10-22-native-ai-research/final-scoped-probe.cjs`（实际以绝对路径运行），生成同目录 `.go` 探针并用 WSL Go 跑生产正则，再以 Node `stripTypeScriptTypes` 执行从当前源文件精确抽取的停服函数/handler。原始输入、结果和 WSL/Node 警告均保存 `final-scoped-probe.log`；进程正常完成。I3 只作源码推导，无额外测试。未调模型/网络、未启动真实 Electron、未访问真实库/凭据。
- 未派子代理，未运行浏览器视觉自动化，未写产品/index/HEAD/main，未执行 git mutation。唯一新增文件为本 ignored 报告及 ignored probe；不重新制作“全绿”证明，不冒充第二次 full review。

## Verdict

**Fix round: Findings remain open — I1、I3、I7。** 七项中 **4 ADDRESSED / 3 NOT ADDRESSED**；剩余 **0 Critical / 3 Important**，其中两项为修复新引入的 Important 行为，已与原 finding 残余去重。原 M1 仍为明确延期的 Minor。

**当前仍不能无条件合入或宣称总体完成。** 本次唯一限定复审已结束；剩余三项需控制者明确裁定和披露，不能因单次修复波次上限或整体交付压力降级/丢弃。本报告不自动授权第二修复波次、第二整分支复审、push/merge/release。


Independent report SHA256: `4654df14dad4ef43bf95bb0d929ba51725539b74993f0b475765fc5fb5ea9852`.
