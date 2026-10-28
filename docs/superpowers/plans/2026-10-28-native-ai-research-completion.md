# 内置 AI 研究：最终验收与本地集成记录

2026-10-28，Tasks 1～11 的 61 项计划要求已核对，原完整分支审查及后续限定复审已完成，三个剩余 Important 全部关闭。用户已明确授权修复后合并到本地 main；未授权推送或发布。

## 最终修复

| 问题 | 结果与提交 |
| --- | --- |
| I1 常见原创概率漏检 | `0249b71` 拒绝指定中英文原创概率，合法科学百分比保留；真实生成回归确认旧成功记录不被无效输出覆盖。 |
| I3 结构化摘要误认证 | `38e3f96` 保留摘要容器/标题层级，`9ad8614` 统一隐藏/活动子树过滤；新全文资格为 dom-body-v2，absent/v1 旧资格不能证明全文。旧缓存正文与历史报告仍可读，不自动重抓。 |
| I7 停服失败后无法退出 | `3717137` 等待真正 close 后结束桌面，保留失败时禁止迁移/重启及不硬杀约束；主进程、真实 helper 与迁移集成回归覆盖异常路径。 |

最终产品提交 `9ad86144ae62f1542de98d7b4addbe006c3ff769`；以上为四个可独立审查、回退的修复提交。随后只有本记录、计划勾选及历史文档状态说明的文档变更。

## 已执行验证

- `pnpm typecheck`、`pnpm test`、`pnpm build` 在最终产品源码上均 EXIT0。Go 全部通过，reader71.238s/scholar1.793s；Vitest170文件通过、3文件跳过，1232测试通过、5跳过。
- 5个跳过分别属于 Linux 下 Windows命令行测试1、显式启用的 backend integration3、布局模型测试1。既存 PDF.js夹具/字体/OffscreenCanvas、React act/空图片、virtua注释和大chunk警告继续披露，未全局屏蔽。
- 外层辅助 gates 脚本在三条命令已全部成功后，因末尾CR空行返回1；真实三条命令的独立日志均为0。该辅助失败保留在报告中，没有重跑已绿命令或改写为应用通过证据。
- 新原生验收 `E:/WSL/reader-native-ai-residual-fix-2-acceptance-v4`：20项全部通过，补充同步PDF计数、候选导入、桌面迁移join和最终inspector通过；受控模型调用69、检索{"arxiv": 9, "crossref": 7}、外部Agent调用0、errors为空。实际构建服务、鉴权HTTP、SQLite、PDF/EPUB原生处理和非空历史数据保全均参与。
- 首次/第二次环境失败及前轮v3保留。新验收只在任务私有命名空间使用验证TLS的真实DoH解析；loopback辅助已回收、socket关闭、宿主解析配置前后hash相同，生产publicIP/TLS/重定向/许可约束未放宽。
- 最新研究PDF6页全部Poppler渲染、实际查看、重开和hash核对，13引用与13附录对应；A/B相反结论和high_overlap/insufficient保留。PDF SHA256 `4ccc4970edb529ff812b4ccc853cb2f85ecdddd082c8d4b11d16bb9772f0835d`；Markdown SHA256 `aafef57200064916069e1d16aa88d9f2055a7db30195b36a893ab37e537cb6cd`。它是工程审计产物，不代表新增应用PDF报告导出/导航功能。
- 既有4个双语PDF共15页、两种布局/公式/字体/9pt/附件/取消验收保留，未变源码没有重复生成。2026-10-25的arXiv/Crossref各一次真实公开小查询为历史可用性烟测，不冒称完整文献覆盖。
- 实际同构建Electron→Go EOF/close退出、独立48样本预览、无Key和外部Agent调用0已记录。915个tracked source/tested mirror/Git blob、10个harness来源、验收/日志/PDF/预览二进制hash已独立核对。

完整最终日志与绑定：`E:/WSL/reader-native-ai-logs/residual-fix-2/i3-followup`。本计划忽略目录的完整审计材料归档到 `E:/WSL/reader-native-ai-audit-2026-10-28/audit.zip`，附 `manifest.json` 逐文件SHA256；归档核对后只清理本计划scratch，不删除其他工作树/书库/依赖。

## 预览与边界

使用桌面「Reader 内置 AI 研究预览」快捷方式打开独立样本库；步骤见[人工验证说明](../../native-ai-research-validation.md)。可先核对Graph文件夹5/4篇范围、A/B冲突及来源回跳，再检查预算继续、候选显式导入、报告修订和两种双语PDF布局。

没有用户提供的真实模型Key，科学判断与翻译质量仍需人工验证。有限语义守卫不识别任意语言，未知网页保守保持未确认。WSLg开发预览包含已披露的启动flags，Windows/macOS原生对话框、安装包没有验收。本次仅本地main集成，没有push、标签、改版本或发布。

## 执行裁定（按原始顺序）

1. 旧CLI配置迁移保留API候选与Key，用户须明确保存后才启用生成；若误判，用户多一次设置操作。
2. Task3退役前，服务端暂留只读旧配置视图以保证中间提交可用；若误判，后续需额外兼容清理。
3. 各阶段跑针对检查，完整typecheck/test/build集中Task11；若误判，集成回归发现较晚，需要在交付前返工。
4. Task1同步调整必要前端消费者，统一NativeAIConfig形状；若误判，前端迁移提前，扩大早期改动与审查量。
5. 6个已复现旧CLI/备份夹具失败留到Task3迁移，Task2原生协议与事务测试先审；若误判，被旧夹具掩盖的问题晚一阶段发现，仍须后续完整门禁修正。
6. 用真实SQLite保存行数替代不会变化的savedAnswers局部计数；若误判，集成夹具维护成本增加，保存完成条件没有放宽。
7. Task2复用已审查的chat_runs/document_tools保存与校验路径，不做无行为意义改动；若误判，遗漏调用点需在后续生命周期迁移或最终验收修复。
8. 翻译须等模型正常完成再提交成功批次，取消/截断前缀不作为成功检查点，保全已有成功译文；若误判，首次可见成功更晚，重试可能重做未提交部分并增加调用量。
9. 主题/会话CRUD按已批准D合同实现创建、列举、读取与修改，不另造未定义的删除/重命名API；若误判，后续需要另定数据保留规则再补接口，现有报告不能因此被删。
10. Task4按实际原文指纹验证语料缓存，包含必要调用点；若误判，增加哈希I/O与兼容工作，必须受取消/有界读取和生命周期测试约束。
11. 仅元数据/摘要成员使用版本化元数据摘要作SourceHash，全文仍用原始字节hash；若误判，未来需独立metadataHash字段/迁移，旧快照需重新创建，不能追认当前内容。
12. 已注册候选在其他文件夹存在可验证本地原件时，允许候选绑定的本地证据读取；若误判，多一条来源校验分支需回退，冻结主题范围和本地工具权限仍不扩张。
13. 用户显式导入作为独立授权，可用于已完成任务或当前会话关闭检索时；绑定最近有效注册会话的当前许可代次并随撤权/退出取消等待，已提交requestId只重放结果；若误判，确定性会话关联可能造成跨会话取消，未来需显式session字段，仍拒绝伪造/删除/外来注册。
14. Task9增加只读results接口及idea依据归因字段，以支持部分成果/分批进度和可展开UI；若误判，新增读接口及消费者需调整，GET不触发工作、不暴露凭据控制信息，旧报告保留。

15. 既存、与本轮产品修复无关的测试/构建警告保留披露并延期逐项清理，不全局屏蔽stderr；审查认定它们是非阻断Minor，本轮集中修复7项实质问题。若误判，噪声可能掩盖后续回归，需要专门清理夹具/测试设置；不豁免任何失败检查或本轮新增警告。

16. I1 常见原创概率漏检保留为阻断，普通科学百分比继续允许；若误判，增加语义校验修复与针对验收成本，不以此接受未经校验的概率断言。
17. I3 结构化摘要误作全文保留为阻断，先补真实 HTTP 反例并确认正文身份；若误判，会延后真实正文可用性并增加兼容测试，现有源码推导不冒称已执行反例。
18. I7 异常停止后永久无法退出保留为阻断，后续须区分进程关闭和清理成功；若误判，增加异常收尾实现与生命周期验证成本，不恢复硬杀或提前迁移。

## 最新 I3 独立限定复审原文

以下报告正文原样保留，SHA256 `1f8564c9cf822ff7ecdf084d103fe6153f2ff53e04adad560b555d2ca90ed426`。此前I1/I7关闭及I3隐藏标题反例的报告仍在完整审计归档中；它的I3残余由本次复审取代。报告中的ignored路径为原执行位置，清理后在归档中按同名文件恢复。

---

**I3. 隐藏／活动标题后代与正文清洗不一致 — ADDRESSED。** `apps/server/internal/scholar/public_http.go:483–497` 将既有活动标签、`hidden` 和 `aria-hidden="true"` 排除规则抽成 `publicTextExcluded`，实际文字遍历在 520 行、标题身份递归在 543 行调用同一函数。原反例中的隐藏后缀不再进入 `Abstract` 的 label；555–556 行能设置 abstractLevel，563 行仍把下属 Methods/Results 文字标为摘要，610–612 行跳过其正文资格。原有排除语义只是集中复用，没有减少既有活动节点列表或放松属性条件。

**I3. 可见嵌套标题／实体及真实正文对照 — ADDRESSED。** 标题提取继续递归可见 TextNode（public_http.go:546–550），HTML parser 仍处理实体。新增 `TestResearchRemoteHeadingVisibilityQualification`（`apps/server/internal/reader/research_remote_test.go:133–177`）经真实受控 HTTP → `readResearchRemote` → 持久化 evidence → `validateNoveltyReport`，验证无后缀 Abstract、hidden、aria-hidden、script/style/button/template、嵌套 Abstract，且每例断言一次 fetch、无 EXCLUDED 内容落盘；真实 `<span>Materials &amp; Methods</span>` 正对照仍有两段 fulltext 并通过 novelty。并非只检查内部 label 或 resource Kind。原 mixed／nested-body 回归也在新 covering log 中通过。

**I3. 新结构证明与 absent／dom-body-v1 旧缓存回放 — ADDRESSED。** `apps/server/internal/reader/research_remote.go:427` 写入 `dom-body-v2`，`research_novelty.go:28–34` 只接受该版本且 `contentLevel=fulltext` 的 remote-html；测试固定证据同步更新（research_novelty_test.go:169）。旧 v1 即使曾错误获得 fulltext，也不能再满足当前重合／方法差异门槛（research_novelty.go:85–96、112–113）。版本升级仅改变资格判断和新证据写入，不变更缓存 protocol/key、不自动抓取或改写历史。

**I3. 有效旧缓存、历史可读性及原安全边界 — ADDRESSED。** `TestResearchRemoteLegacyHTMLQualificationIsUnconfirmed`（research_remote_test.go:216–295）分别重建 absent／v1 资格，保持 cache/evidence 一致的 payload 与 hash；fixture 先显式发送 text/html（220 行），且必须有至少两段真实 qualified body（227–235 行），因此不能再以未实际取得全文的 fixture 假通过。276–290 行断言回放仍仅一次 fetch、返回证据序列化字节与旧 cache 相同、每条可 resolve、fulltext 判定失败且 novelty 拒绝。源码的 cache 命中分支仍在 research_remote.go:345–355 直接校验并返回；283–322 行的注册版本、protocol、owner、unit hash、证据精确比较、stale 处理未改动。本轮 diff 也没有修改权限、generation、删除失效、公网 IP、dial、redirect、TLS、体积或取消边界。

## New Breakage in the Fix Diff

- **None。0 Critical / 0 Important / 0 新增 Minor。** 完整读取 18,720-byte 标准 package 的一个 commit、五个路径；实现改动是共用排除谓词和两个匹配的 v2 字符串，测试新增原反例并强化既有缓存 fixture。未发现此次 diff 引入的新破坏。
- **证据记录中的外层退出错误已如实保留，不是未解决产品 finding。** `root-wrapper-exit.json` 记录 outer session 73236 exit1，原因是 final-gates.sh 在三项实际 EXIT0 后遇到最后 CR-only 空行（line27）。已读原脚本及三项真实日志尾部；没有把外层脚本称为 exit0，也没有为刷新状态重复运行门禁。

## Out-of-Scope Observations / Declined to Judge

- **I1／I7：不重审。** 上一份 residual-fix-2-review.md 在 3717137 已独立判为 ADDRESSED，本轮没有它们的实现改动；不据此重新打开全分支 review。
- **先前关闭的 I2／I4／I5／I6 及延期 M1 警告／skip：不重审。** 当前任务仅最后 I3 修复及本 diff 新破坏；现有警告与跳过范围保留。
- **任意 CSS 隐藏语义、未知出版商完整全文识别、真实模型的科学质量：不作超出证据的保证。** 本修复统一产品既有 active/hidden 子树规则；模糊 DOM 的保守降级和科学质量边界不变，没有在本 diff 发现新的具体范围外缺陷。
- **Windows 安装器／OS 视觉验收、旧双语 15 页材料、旧公网 smoke：不重复。** 新 preview 证据为 Linux WSLg，controller 承担本次六页 PDF 实际视觉 QA；不把读取其记录冒称本 reviewer 重新视觉验收。

## Checks and Evidence Boundary

- **固定范围及实际只读检查：** BASE `37171374d78b231f49042789341fb76fdb284766` → HEAD `9ad86144ae62f1542de98d7b4addbe006c3ff769`，commit `9ad8614 fix(research): qualify headings from visible text only`。开始实际核对工作树 `C:/Users/Administrator/.codex/worktrees/native-ai-research/reader`、branch `codex/native-ai-research`、HEAD、clean status；无 AGENTS.local.md。读 READY context、followup、brief、上一 review 的实际 I3 反例、新报告 appended DONE_WITH_CONCERNS、完整 package 与限定调用链。实际 `git diff --check BASE..HEAD` 无输出；package 长度与五路径 stat 一致。未移动 HEAD、修改 index／产品／main 或执行合并。
- **已读真实 RED：** 新证据根目录 `E:/WSL/reader-native-ai-logs/residual-fix-2/i3-followup`。`red2.sh` 的具名命令为 `go test ./internal/reader -run 'TestResearchRemote(HeadingVisibilityQualification|LegacyHTMLQualificationIsUnconfirmed)' -count=1 -v`；`red2.log` 为 EXIT1，四个隐藏／活动／嵌套 Abstract 实际 1 fetch、2 fulltext、noveltyAccepted=true；plain Abstract 为0／false，真实正文为2／true。有效 v1 cache 实际被误接受，absent 对照通过。此日志支持真实行为 RED；先前 red.log 中不足的 cache fixture 不作为该缓存证明。
- **已读真实 GREEN：** `green2.sh/log` 的命令为 `go test ./internal/scholar ./internal/reader -run 'Test(Public|ResearchRemote|ResearchNovelty)' -count=1 -v`，EXIT0，scholar1.135s／reader11.269s。原四个错误例和 plain 对照现在每例1 fetch、0 fulltext、noveltyAccepted=false；真实可见正文仍2／true；absent／v1 cache 两例均通过。可见 existing HTML mixed／nested body、remote 所有权／stale／删除／预算／取消、公网 IP／redirect／TLS／MIME 等具名测试通过。保留的 green.log EXIT1 属于版本修改时 GBK 解码辅助脚本失败，不称作产品 RED。
- **已读新 settled root gates，未重跑：** `final-typecheck.log`、`final-test.log`、`final-build.log` 各实际 EXIT0；Go reader71.238s／scholar1.793s，Vitest170 passed files／3 skipped、1232 passed tests／5 skipped。外层退出1与上述命令退出分开记录。
- **已读新 native v4，未重跑：** `v4/acceptance-final.log` EXIT0，20 PASS、同步 PDF count／candidate import／desktop migration join／inspector PASS。`E:/WSL/reader-native-ai-residual-fix-2-acceptance-v4/result.json` 的 implementationCommit 为新 HEAD，20 checks true，errors/warnings=[]，controlled modelCalls69、arxiv9／crossref7、externalAgentCalls0。这是工程受控模型证据，不是真模型科学结论。
- **已读新清理记录：** `v4/dns-forwarding.json` 的63条记录均 tlsVerified、0 errors；监听仅127.0.0.2:53、closed=true、childExit0、hostUnchanged=true。`v4/final-cleanup-verification.json` 记录无匹配 helper 进程、任务 socket 已关闭，host resolver 前／后／current SHA256 均 `480ec998945eff4601da3bff0e220cfc009ff83eeecf128cd880fe50c7a2c9d3`。这些是已有实际执行记录，本 reviewer 未新增网络操作或改变主机配置。
- **已读新 preview／PDF：** preview-shutdown.json 为新构建 Electron849→Go952 正常 EOF/close、exit0、discovery removed；preview-verification.json 为独立 launcher1120→1190、45055端口、48样例、endpoint空／hasKeyfalse／trap0、health/HTML200、auth401+200，server SHA256 `f1966e1b3989dc12e37a57f2a7f12352879af4e706c66b5c649d6f77117431c4`。旧PID复用保护拒绝向 acceptance Go 发信号的记录保留。controller-pdf-qa.json 记录六页实际 view_image／无裁切重叠、13引用／附录、反向A/B及 high_overlap／insufficient 保留；PDF SHA256 `4ccc4970edb529ff812b4ccc853cb2f85ecdddd082c8d4b11d16bb9772f0835d`，MD SHA256 `aafef57200064916069e1d16aa88d9f2055a7db30195b36a893ab37e537cb6cd`。
- **实际新增执行的证据核对：** 用只读 Get-FileHash 重新计算 manifest 中全部9个真实日志、6个 supporting evidence 文件，均与 final-evidence-binding.json 匹配。读取 final-source-binding.json、final-head-binding-windows.json 与 controller-requirements-source-check.json：记录全部915 raw source／mirror／native Git blobs、10 harness hashes及新 HEAD绑定；本 reviewer 没有重算全部915文件，不把 controller 的实际审计当作自己执行。manifest 内 `base=16d710b` 是整个第二波绑定基线，本 scoped review 的 base 始终为3717137。PDF logical reopen 的 pending 字段属较早记录，后续独立 controller QA hash 已绑定，未以该 pending 字段否认已完成 QA。
- **本 reviewer 未运行新测试／suite。** 完整 diff 与已有回归已回答限定源码疑问，无未解具体疑问需要新增 focused 反例。判断依据明确区分：上述 Git／hash 读取为本次实际执行；RED/GREEN／门禁／native／preview／PDF 为读取已有实际记录；共同排除语义和命中缓存无写入为源码推导。无子代理、真实库／模型／凭据访问、浏览器视觉自动化、push／release／merge。

## Verdict

**Fix round: All findings addressed, no new Critical/Important breakage。** 最后 I3 隐藏标题残余及其旧缓存边界均 **ADDRESSED**；无新增阻塞 finding。

**此 I3 follow-up 在 HEAD 9ad8614 已具备本地合并就绪条件。** 本结论限定上述修复范围，保留既有延期警告、科学质量与 WSLg／Windows 安装器边界；不重复请求已给出的本地合并授权。controller 负责后续集成，本 reviewer 未执行合并。

独立复审原文结束。
