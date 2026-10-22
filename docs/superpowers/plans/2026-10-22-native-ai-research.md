# Reader 内置 AI 与主题研究实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reader 仅凭用户配置的模型 API 提供现有 AI 功能，以及主题文件夹综述、跨论文问答、idea 探索和按需联网查新。

**Architecture:** 在 Go 内统一模型传输、工具循环、持久会话与可恢复任务，替换外部 Agent/Pi 调度；以 PaperItem 范围快照和实际已读证据支持跨文献综合。研究任务串联本地阅读、arXiv/Crossref 检索及公开论文读取；SQLite 保存成功单元、来源、候选与修订，React 提供主题研究入口和可信引用。

**Tech Stack:** 现有 Go/SQLite FTS5、net/http、OpenAI Chat Completions/Anthropic Messages、React/Vite、packages/ui、PDF.js/Readium、Electron、Vitest；不新增模型托管、Agent SDK、向量数据库或独立搜索 Key。

**Spec:** `docs/superpowers/specs/2026-10-22-native-ai-research-design.md`（用户已确认）。基线 `c07f2214ef1025dedc998f70ac03c45a426b4b71`；包含双语 PDF 源码 `1fb835d`。在 `codex/native-ai-research` 工作树中执行；main 与原双语 PDF 工作树保持独立。

## Global Constraints

- Reader 通过用户配置的 API 地址、API Key 和模型提供 AI 功能，不再关联或依赖 Codex、Claude Code、Kimi 等外部 Agent。Reader 自己管理会话、上下文、工具调用和任务。
- 第一版使用现有 Go 后端实现模型/工具循环；移除 AI 运行链路中的 CLI 适配器、Codex 持久 thread、Kimi ACP、Claude CLI 及 Pi 调度/依赖。PDF 处理所需的 Node worker、Electron 和非 AI 的 `reader` 命令行仍保留。
- 第一版采用一个主要 API 连接，并按用途指定模型；研究模型留空时继承问答模型。允许自定义兼容端点和用户明确配置的本地模型端点。
- 文件夹研究默认遵循当前书库对子文件夹的包含设置，并允许在研究范围中调整；默认选择每篇文献的可读原文附件，避免把译文附件当成第二篇论文。
- 联网权限归研究会话，默认关闭；用户明确提出联网查新/找论文即开启该次任务权限。普通本地综述不会自行调用论文搜索服务。模型 API 请求与论文检索联网是两类不同的网络行为。
- 第一版内置 arXiv 与 Crossref 主题检索，无需用户另外配置搜索密钥；候选不自动导入，不改文件夹、标签、原文或引用键。
- 完整响应正常结束、输出结构与来源校验通过后才保存成功结果；已可见的部分输出不自动接备用模型或追加兜底答案。沿用 SSE 的 draft/delta/activity/reasoning/done/error 语义，done 只能在保存成功后发送。
- 部分输出、检查点、标题、摘要不是完整原文证据。PDF 使用页码/块；EPUB 使用原生章节/位置；网络摘要、HTML 段落和 PDF 页分别表达。
- 查询、工具、文献和网页均为不可信数据；仅运行注册的读工具。论文下载的公开地址限制不得误伤用户显式配置的本地模型 API。
- 只有完成信号及证据校验成功的单元可作为检查点；重启时将进行中任务标为中断并显式提供继续；不得在启动时自动重放模型或网络调用。
- 退出应用、迁移书库或删除相关资料时取消并等待模型 HTTP、下载和解析工作结束，清理仅本任务拥有的临时文件。原文、阅读译文、批注、笔记、历史问答和稳定引用键必须保全。
- 最终执行 `pnpm typecheck`、`pnpm test`、`pnpm build`；在 E 盘承载的 WSL 环境提供隔离预览与样本。禁止浏览器自动化做界面视觉验收；真实 API/在线烟测和 mock 覆盖分别报告。
- 按可验证功能小步提交，不推送/合并/发布，除非用户后续明确要求。设计三部分必须全部交付，阶段性通过不是整体完成。

## Review Focus

1. 旧用户只有 TextAPI/ImageAPI、保存用途模型时没有提交 Key、或修改端点：不能丢 Key、暗选付费连接或把旧 Key 发给新站点（Task 1 的迁移/编辑测试）。
2. 多篇 PDF 恰好都有 `p1-b1`、附件含译本、预印本与正式版标题相同：证据和去重必须按论文/文档/版本区分（Tasks 4、5、7、8）。
3. 创建/开始/继续 POST 已执行但响应丢失、研究页卸载、HTTP 断流：同任务查询和幂等恢复，不自动重放付费调用；已开始后台任务不因页面切换被误删（Tasks 6、10）。
4. 网络只剩摘要、一个来源限流、DNS 重绑定/重定向至内网、模型端点本来就在 localhost：不得假装读过全文或“确定新颖”，不得破坏合法本地模型（Tasks 7—9）。
5. 删除/替换论文、改名/移除文件夹、迁移/退出发生在读取或最终提交前：取消等待无锁循环、失效来源不可借缓存复活、旧成功报告和其他文献不丢失（Tasks 3—6、8、10、11）。

## 执行环境与分段交付

任务依赖是一条主线：`1→2→3→4→5→6→7→8→9→10→11`。前三项交付独立可用的原生 AI；4—6 交付可用的本地主题研究 HTTP 功能；7—9 扩展联网与 idea；10 提供完整界面；11 整体验收。统一计划保留跨阶段接口，不把它们拆成互不约束的项目。

源工作树：`C:/Users/Administrator/.codex/worktrees/native-ai-research/reader`。实施时建立专用 native mirror `/home/admin/.cache/reader-native-ai-check`，WSL Ubuntu 的磁盘在 E:；不在 C: 安装 node_modules。开发辅助同步脚本 `E:/WSL/reader-native-ai-sync.sh` 只同步本工作树到上述专用镜像，排除 `.git/node_modules/.reader/.superpowers/dist/bin`；不得复用旧双语同步脚本覆盖另一分支。依赖使用现有 pnpm store，锁文件变化后在 native mirror 安装/校验。

WSL PATH 固定为 `/home/admin/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`。需要 Git 元数据时，从本工作树 `git rev-parse --git-dir` 的实际值转换为 WSL 路径（当前 reader2），设置 `GIT_DIR` 与镜像 `GIT_WORK_TREE`；不要硬抄 reader1。新镜像首次执行前确认同基线，然后跑现有 focused tests；记录 baseline 失败，勿把旧警告称为新改动成功。

每项下面的测试输出均是**执行时的预期结果**，不是当前已通过声明。每项 RED→实现→GREEN→审 diff/精确暂存/`git diff --cached --check`→提交；只列焦点命令，不在每一步重复全量构建。全量验证在 Task 11 的最终产品源码完成后执行；文档改动仅内容/diff 检查。

## 文件职责与共享接口

### A. 内置 AI（Task 1 定义配置，Task 2 定义运行接口，Task 3 完成退役）

- `packages/reader-core/src/native-ai.ts`：`AIModelRole = 'chat'|'translation'|'vision'|'research'`；`NativeAIConfig {version:2;connection:{protocol:'openai'|'anthropic';url:string;hasKey:boolean};models:Partial<Record<AIModelRole,string>>;efforts:Partial<Record<AIModelRole,ReasoningEffort>>;apiModels:string[];translationPrompt?:string;needsConfiguration?:string}`。新用途和公开配置从 core index 导出。
- `NativeAIConfigUpdate` 的公开字段同上（不接收 hasKey），另含 `connection.key?:string|null`：省略仅在规范化端点/协议未变时保留旧 Key；字符串替换，null 明确清空。端点变更且未提供 key 时存为待配置/无 Key，不把旧 Key 转发；明确无 Key 的本地端点可使用。新增 GET/PUT 仍使用 `/api/ai/config`，读响应从不含 key。
- `native_ai_config.go`：`(*Server).nativeAIConfig() (NativeAIConfig,error)`、`saveNativeAIConfig(NativeAIConfigUpdate) (NativeAIConfig,error)`、`resolveNativeTask(context.Context,NativeAIConfig,modelTask) (nativeTaskSnapshot,error)`；snapshot 拥有私有 `APIConnection`、已选 model/effort、能力/窗口及配置指纹，不能作为 HTTP 输出。模型列表/测试仍走已存在的本地 AI API，Task 1 在 OpenAPI 中固定用途参数为 role；不再要求 provider 参数。
- 模型HTTP合同：`GET /api/ai/models?role=...` 返回现有AgentModel数组（类型名可保留，语义为API模型），`POST /api/ai/check {role,model?,waitSeconds?}` 返回现有AICapability及对应模型身份/指纹，waitSeconds1..60默认15；只在用户点击检测时运行推理探针。旧primary是API时按原用途迁移；旧primary为CLI但有备用API时保留候选/Key并设置needsConfiguration，先由用户保存确认主要连接，不在升级启动时产生新API费用。
- `native_ai_migration.go`：读取旧 `ai-connections.json`，写受保护的 version2 原子配置并保留一次旧文件备份；不得删用户外部软件。Task 1 可保留一个仅服务端的旧 `AIConfig` 适配层供现有 generation 调用，固定 primary=api，Task 3 移除该桥；新旧设置不能成为两个独立真源。
- `nativeTaskSnapshot {Connection APIConnection;Model,Effort,Fingerprint string;ContextWindow,MaxOutputTokens int;Text,Vision,Tools bool}` 仅在服务端内存存在；持久续接只保存非秘密指纹，用于判定继续时当前配置是否一致。needsConfiguration存在时generation桥也必须拒绝运行，不能借临时兼容层自动启用原CLI用户的备用API。
- 用途解析在发请求前一次确定：chat优先显式模型，否则用现有catalog的默认推荐；translation优先显式模型，否则沿用API快速模型选择，再回到已解析chat模型；research空值继承chat；vision优先显式模型，否则只可复用已验证支持视觉的chat模型，均不可用则明确纯文字模式。没有可用chat模型时返回待配置，不能靠启动外部CLI补齐。模型ID可手填；未知工具/视觉能力按未启用处理，使用文字检索辅助直到用户主动检测通过。
- `native_ai_loop.go`：`runNativeLoop(ctx context.Context,in nativeLoopRequest,emit func(ProviderEvent)error) (nativeLoopResult,error)`；request `{Snapshot nativeTaskSnapshot;Input AIInput;Window nativeConversation;Tools nativeToolset;Budget nativeLoopBudget}`，result `{Result GenerateResult;Window nativeConversation}`。证据由各scope工具适配器持有并在外层保存，不引入 research 表依赖。
- `nativeToolset`：`Definitions(vision bool) []any`、`Call(ctx context.Context,name string,args json.RawMessage) (nativeToolResult,error)`、`Check(ctx context.Context) error`、`ValidateAnswer(ctx context.Context,text string) error`；result `{Content json.RawMessage;Images []nativeToolImage}`，image `{SourceID,MIME,Label string;Data []byte}` 为仅运行时类型，沿用已有页图大小预算且不写入审计正文；本地/网络页图通过各自已读来源映射，不伪装书库Document。`nativeConversation` 保留完整协议消息组和压缩检查点，不保存外部私有 thread/entries。
- `nativeConversation {Messages []toolCompletionMessage;Checkpoints []string;ConnectionKey,ScopeRevision string}`；`nativeLoopBudget {MaxRounds,MaxToolCalls,MaxOutputBytes int;Timeout time.Duration}`，交互默认64轮/128工具/1MiB/10分钟。研究长任务仍受外层ResearchBudget限额，循环开始/压缩/重试前向外层实际调用计数器预留；累计统计包含失败尝试和压缩请求，不能靠内部重试绕过预算。
- `native_ai_conversation.go`/`native_ai_lifecycle.go`：持久窗口与可见历史重建、事务提交及 close/join；现有 `Adapter.Stream`、`GenerateRequest`、`GenerateResult`、`ProviderEvent` 和 usage 保留为调用侧接口。文档和研究适配器共享模型循环，不共享源范围。

### B. 研究实体、任务与证据（Tasks 4—6）

- `packages/reader-core/src/research.ts` 与 `research_types.go` 同步约定：`ResearchTopic {id,title,folder,includeChildren,networkAllowed,scopeState:'active'|'detached',createdAt,updatedAt}`；`ResearchSnapshot {id,topicId,revision,members:ResearchMember[],createdAt}`。Member `{paperId,documentId?,citationKey,title,sourceHash?,corpusRevision?,coverage:'fulltext'|'abstract'|'metadata'|'unavailable',reason?}`。每篇 PaperItem 只取一份原文；revision 是有序成员/内容/解析/元数据的摘要，不依赖绝对磁盘路径。
- `ResearchSession {id,topicId,title,networkAllowed,createdAt,updatedAt}`；networkAllowed 从 topic 创建时继承，可在会话修改。`ResearchEvidence {id,topicId,snapshotId,runId,paperId?,documentId?,candidateId?,kind:'local-passage'|'local-page'|'remote-abstract'|'remote-html'|'remote-page';revision,contentHash,location,excerpt,readAt,availability:'valid'|'stale'|'removed'}`；不在跨论文间复用裸 blockId。
- `ResearchRunInput {userMessageId:string;question:string;mode:'question'|'overview'|'compare'|'ideas'|'novelty';ideaId?:string;network:'inherit'|'allow-task'|'deny';budget:ResearchBudget}`，userMessageId 为32位小写hex。客户端明确的联网找论文/查新动作发送 allow-task；模型输出、网页或关键词命中不授予权限。自由输入时，仅会话已允许联网才能由模型按需检索；未允许时给出启用联网的可行动提示。
- `ResearchRunInput.urls?:string[]` 最多8个、每个最长4096字符，来自用户明确粘贴的论文链接/输入附件而非模型或网页派生URL；仅在已授予联网时登记为该run的用户候选，由同一公开HTTP规则解析。`read_online_paper`仍只接受已登记candidateId，不接受模型任意URL。
- `ResearchRun {id,topicId,sessionId,userMessageId,status:'preparing'|'queued'|'running'|'paused'|'interrupted'|'completed'|'failed'|'canceled';phase:'snapshot'|'reading'|'searching'|'synthesizing'|'checking';snapshotId,revision,done,total,coverage,error?,limitReason?,latestReportId?,updatedAt}`。创建只快照/预检，`POST start` 才发模型/论文请求；执行未完成返回202，查询返回200。
- `ResearchCoverage {totalPapers,analyzedPapers,abstractOnlyPapers,unavailablePapers,pendingPapers,readUnits,totalUnits}`；均为非负整数，并附每篇readCoverage。阶段done/total和实际已读范围分别显示，run.completed不意味着读过未获取的图表或论文全文。`ResearchControl {requestId:string;budget?:ResearchBudget}`（requestId为32位小写hex）；start/pause/resume/cancel都带新动作requestId，重试沿用同ID。control单元使用`unit_key='control:'+requestId`持久化动作/内容hash与已接受结果，重复相同动作不重开预算，内容冲突409。
- `ResearchReport {id,topicId,sessionId,runId?,sourceRunId?,kind,revision,sourceRevision,origin:'model'|'user',derivedFromId?,content,sourceIds:string[],coverage,stale:boolean,createdAt}`；完成报告为新修订，不覆盖先前成功版本。用户编辑产生origin=user新修订，保留原版、原来源和sourceRunId，不冒称模型验证。`ResearchPaperCard {cacheKey,paperId,documentId?,revision,level:'fulltext'|'abstract'|'metadata',problem,method,assumptions,dataAndEvaluation,findings,limitations,evidenceIds:string[],readCoverage}`，除纯元数据字段外每个事实字段须绑定证据；readCoverage记录totalUnits/readUnits/实际范围，level表示资料级别，不能单凭fulltext标签声称整篇已读。
- `research_migration.go` 在 OpenStore 中建立12个表：`research_topics`、`research_sessions`、`research_snapshots`、`research_runs`、`research_units`、`research_cards`、`research_evidence`、`research_candidates`、`research_searches`、`research_reports`、`research_conversations`、`research_messages`。实体以 id TEXT PK、body TEXT（JSON）、created_at/updated_at TEXT 为基本列；另存真实索引字段：sessions.topic_id；snapshots.topic_id/revision；runs.topic_id/session_id/user_message_id/status/request_hash；units.(run_id,unit_key)联合PK/kind/status；cards.cache_key主键/paper_id/document_id/revision；evidence.topic_id/snapshot_id/run_id/paper_id/document_id/candidate_id/availability；candidates.topic_id/identity_key；searches.topic_id/run_id；reports.topic_id/session_id/run_id/revision；conversations.session_id主键/connection_key/revision；messages.session_id/run_id。JSON body 不重复存 Key/私有快照。
- 约束：runs UNIQUE(session_id,user_message_id)，candidates UNIQUE(topic_id,identity_key)，reports UNIQUE(run_id)及UNIQUE(user_request_id)（两列均可NULL，用户修订无run_id），units PK(run_id,unit_key)。topic/session 下属研究数据可 FK 关联；evidence/card 的 paper/document 身份使用可失效引用而非删除时级联清掉用户报告。所有表创建在单个可重复执行事务中，保留老库 snapshot，清理源 payload 与保留用户报告是不同操作。cards/conversations/units使用上文指定主键，替代基本id列。
- `research_scope.go`：`(*Server).snapshotResearchScope(ctx context.Context,topicID string) (ResearchSnapshot,error)`；`research_tools.go`：`(*Server).researchTools(ctx context.Context,runID string) (nativeToolset,error)`，工具名 `list_papers/get_paper_outline/search_papers/read_paper_passage/read_paper_pages`；列表/检索可不传paperId，按篇读取选择器必须含paperId，读取时再校验snapshot成员与当前文档版本。
- `research_cards.go`：`(*Server).analyzeResearchPaper(ctx context.Context,runID,paperID string) (ResearchPaperCard,error)`；缓存键覆盖正文/解析、提取协议、模型/提示及资料级别。不得把单篇摘要限制悄悄变成全文件夹只取前 N 篇。
- `research_jobs.go`：`(*Server).createResearchRun(ctx context.Context,topicID,sessionID string,in ResearchRunInput) (ResearchRun,error)`、`(*Server).controlResearchRun(ctx context.Context,runID,action string,in ResearchControl) (ResearchRun,error)`、`(*Server).getResearchRun(ctx context.Context,runID string) (ResearchRun,error)`；action 为 start/pause/resume/cancel。暂停/取消先取消并 join 当前 I/O，再完成状态事务。

### C. 联网与查新（Tasks 7—9）

- `internal/scholar/search.go`：`(*Client).Search(ctx context.Context,in SearchQuery) (SearchPage,error)`；Query `{Source:'arxiv'|'crossref';Text string;FromYear,ToYear int;Cursor string;Limit int}`，Limit1..20；Page `{Items []Candidate;NextCursor string;Source string;FetchedAt string}`。Candidate `{IdentityKey,Title,Authors,DOI,ArXiv,PublishedAt,UpdatedAt,Abstract,LandingURL,PDFURL string;Aliases []string}`；同标识符合并，标题相似只提示关联。
- `internal/scholar/public_http.go`/`rate_limit.go`：专门的公开资料客户端和全局来源限速；不借用模型 Key/HTTP 客户端；可注入 resolver/dial/clock 供真实边界测试。`(*Client).FetchPublic(ctx context.Context,url,kind string) (PublicResource,error)` 返回 finalURL/contentType/bytes/hash/fetchedAt；公开 HTML 与 PDF 的解析结果进入 `research_remote.go` 中的 ResearchEvidence，不直接成为书库 Document。
- `research_network.go` 在本地工具上增加 `search_papers_online/read_online_paper`；记录 `ResearchSearch {id,runId,query,source,filters,status:'ok'|'failed'|'limited',candidateIds,fetchedAt,error?}`。`(*Server).setResearchNetwork(ctx context.Context,sessionID string,allowed bool) error` 增加许可generation，关闭时取消并join该会话网络请求，已读本地资料不丢失；模型私有工具不能修改许可。
- `research_candidates.go`：`(*Server).importResearchCandidate(ctx context.Context,topicID,candidateID,requestID string) (Document,error)`，只由用户HTTP动作调用；复用现有scholar/导入事务/去重及原主附件保全，模型没有这个写工具。候选与本地身份明确关联，删除原文后旧候选缓存不得绕过失效规则读取。
- `research_ideas.go`：`(*Server).exploreResearchIdeas(ctx context.Context,runID string) ([]ResearchIdea,error)`；Idea `{id,problem,mechanism,hypotheses,changes,nearestWorkIds,minimumExperiment,baselines,ablations,falsification,resources,claims[]}`；claim `{id,kind:'problem'|'method'|'experiment',text}`，默认生成3个、用户可指定1..3；详细novelty针对明确ideaId或当前生成的候选逐项进行。
- `ResearchRunInput` 另有 `ideaCount?:number`（1..3，默认3）；`novelty`模式必须指定ideaId，`ideas`模式先保存新候选再逐项核查主张，预算不足保留候选和已完成查询、标记未核查项，不捏造完成。ResearchIdea/NoveltyReport存为research_units中的结构化成功单元，报告引用它们的稳定ID；无须另建一套idea任务。
- `research_novelty.go`：`(*Server).checkResearchNovelty(ctx context.Context,runID,ideaID string) (NoveltyReport,error)`、`validateNoveltyReport(report NoveltyReport,evidence []ResearchEvidence,searches []ResearchSearch) error`。Row `{claimId,status:'high_overlap'|'partial_overlap'|'not_found'|'insufficient',relatedWorkIds,evidenceIds,overlap,difference,unverified}`，报告携带queryIds/asOf/coverage/caveats。不使用“绝对原创”或无依据的百分比；具体方法/实验没有全文证据时不可标为已证实差异。

### D. API、前端与预算（所有任务维护自己交付的 schema/client）

研究路由统一以 `/api/research` 为前缀：

| 路由 | 行为/返回 |
| --- | --- |
| POST/GET `/topics`；GET/PATCH `/topics/{topic}` | 创建/列举/查询/改范围设置，返回 ResearchTopic；创建不发模型请求 |
| POST/GET `/topics/{topic}/sessions` | 创建/列举会话；GET `/sessions/{session}/messages` 返回成功保存的历史及末尾未回答问题 |
| PATCH `/sessions/{session}/network` | `{allowed:boolean}`；关闭会 join 网络工作，返回204 |
| POST `/topics/{topic}/sessions/{session}/runs` | ResearchRunInput → ResearchRun；按 userMessageId 幂等，changed body409 |
| GET `/runs/{run}`；POST `/runs/{run}/{start,pause,resume,cancel}` | 查询/ResearchControl控制；服务端再次核对所属topic/session、请求ID与输入快照 |
| GET `/runs/{run}/events?after=N` | 只读 SSE，从已保存/暂存事件序号恢复，不发起任务；draft/delta/activity/reasoning/done/error 原语义，done后可查询报告 |
| GET `/topics/{topic}/reports`、`/reports/{report}`、`/reports/{report}/markdown` | 查修订/读取/导出；导出不写书库，不下载远程内容 |
| POST `/reports/{report}/revisions` | `{requestId,content}`保存用户新修订，返回ResearchReport；重试同requestId/body幂等，改变body409；旧版本不覆盖 |
| GET `/topics/{topic}/candidates`、`/topics/{topic}/searches` | 候选与真实查询/失败/覆盖列表 |
| POST `/topics/{topic}/candidates/{candidate}/import` | `{requestId}`，显式导入，返回 Document；重复同requestId不重复操作 |
| GET `/sources/{source}` | 验证来源状态后返回定位描述/允许的内容，失效409或removed标记，不猜跳转位置 |

OpenAPI 同时定义 NativeAIConfig、Research*、Novelty*；`pnpm api:generate` 生成 schema.d.ts。API client 分成 `src/native-ai.ts` 和 `src/research.ts`，共用从 `index.ts` 抽出的 `transport.ts`，不复制鉴权/fetch逻辑；导出 `researchAPI` 的方法与路由动词一一对应，ID/布尔字段及 AbortSignal 不混用。

工程默认预算由 Task 6 实现为 `ResearchBudget {maxModelRequests,maxSearchRequests,maxRemoteReads,maxMinutes}`：默认200/24/8/30，显式上限1000/100/50/120。原文数量不受该值截断；耗尽时 paused+limitReason，total/remaining 与成功单位保留，可显式继续。每次继续重置本次尝试预算并明确展示会再次调用模型；累计实际调用/用量仍保留。同主题一个活动任务，全局两个；单模型请求3分钟，单工具回包64KiB，研究报告4MiB，paper card256KiB。单文档交互沿用最多64轮/128工具/10分钟及现有1MiB展示边界；长研究报告由受控结构化步骤分节生成与验证后组合，不靠扩大交互展示上限。窗口不足或长回包采用有cursor的继续读取，不静默截断证据或增加覆盖计数。

论文公网响应限制：元数据8MiB、HTML4MiB、PDF64MiB；请求90秒、最多5次重定向。arXiv全局单连接、两次请求至少3秒；Crossref默认并发1/至少1秒间隔，读取Retry-After及返回的额度信息；最多2次重试，仅429/临时5xx/安全的GET网络错误，计入网络预算并可取消等待。TLS/正文截断/私网/协议错误不盲重试。研究临时下载每run512MiB/全局1GiB，只回收任务自有可重取文件；不回收用户原文/已保存报告。普通检索缓存24h并显示真实fetchedAt；新 novelty 主动请求新查询，继续旧run保留原日期并提示时间范围。

## Task 1: 原生配置、迁移及 AI 设置

**Files:** Create `packages/reader-core/src/native-ai.ts`、`apps/server/internal/reader/native_ai_{config,migration}.go`、`native_ai_config_test.go`、`apps/web/src/ai/AISettings.tsx`、`apps/web/src/ai/ai-settings.test.tsx`、`packages/api-client/src/{native-ai,transport}.ts`；Modify `connections.go`、`api_agent.go`、`models.go`、`model_defaults.go`、`packages/reader-core/src/index.ts`、`packages/api-client/src/index.ts`、`apps/web/src/Settings.tsx`、`TaskModels.tsx`、`ModelSelector.tsx`、`store.ts`、`docs/openapi.yaml` 与 generated schema。

**Interfaces:** 产生 A 中 NativeAIConfig/Update、nativeAIConfig/saveNativeAIConfig/resolveNativeTask；保留仅服务端临时 legacy bridge。Task 2 消费 frozen snapshot；Task 3 移除 bridge，不再引入另一套配置持久源。

- [ ] 写 `TestNativeAIConfigMigrationAndKeyEdits`：v1.API优先完整迁移；TextAPI唯一且无API时可迁移，冲突/仅CLI则needsConfiguration；遗漏Key只在同端点保留，换端点不复用，null清空；旧文件备份一次/重启幂等/0600，故障原文件不损坏。断言 `publicJSON` 不含 `"sk-test-secret"`，只有hasKey；迁移不碰旧问答/笔记/译文。
- [ ] 写 UI 测试 `configures one connection and role models without external Agent controls`，断言无SDK/登录/安装选项，研究继承问答、模型列表失败仍保留手填值、保存模型不清Key；用现有连接probe测试补 secret/error/localhost模型端点边界。
- [ ] RED：`cd apps/server && go test ./internal/reader -run TestNativeAIConfig -count=1`；`pnpm exec vitest run apps/web/src/ai/ai-settings.test.tsx`。预期新类型/路由/行为缺失而失败。
- [ ] 实现上述精确配置接口与原子迁移；Settings只将AI区域提为新组件，不重排整个设置；TaskModels/ModelSelector用role，catalog/probe按端点+模型指纹失效。公共端点不接受 legacy provider；迁移parser可读legacy。暂存必要generation桥，写入仍落version2真源。
- [ ] GREEN：上述两条命令、`pnpm api:generate`、`pnpm typecheck` 全成功；审准确配置/组件/生成文件并提交 `feat(ai): add native API configuration and migration`。

## Task 2: Reader 自有模型/工具循环与持久会话

**Files:** Create `native_ai_loop.go`、`native_ai_conversation.go`、`native_ai_tools.go`、`native_ai_loop_test.go`、`native_ai_conversation_test.go`；Modify `api_chat_tools.go`、`api_conversation_compact.go`、`api_anthropic.go`、`api_agent.go`、`api_stream.go`、`api_page_images.go`、`document_conversation.go`、`chat_context.go`、`chat_sessions.go`、`chat_runs.go`、`chat_stream.go`、`document_tools.go`。

**Interfaces:** 消费 nativeTaskSnapshot，产生 A 中 runNativeLoop/nativeToolset/nativeConversation/nativeLoopResult。documentToolset 包装既有 `documentAgent`，保持 `get_outline/search_document/read_passage/read_pdf_pages` 和来源验证；研究下一阶段不必依赖 documentAgent 内部 Codex 字段。

- [ ] 写 `TestNativeLoopOpenAIAndAnthropicCompletion`，使用同一套transcript fixture验证文字/工具/图片、分片参数、未知/重复工具ID、明确finish、断流、取消；断言 `if savedAnswers != 0 { t.Fatal(savedAnswers) }` 直到正常结束与来源校验。失败后无Fallback/第二模型调用，draft/reasoning已可见时同样如此。
- [ ] 写 `TestNativeSessionRebuildAndCompaction`：以可见历史重建旧CLI/Pi会话，保留消息ID/来源/阅读位置；不消费piEntries/thread ID；换端点或模型重建窗口；压缩只切完整调用-结果组，失败不覆盖历史；SessionID非空也不调用Pi。
- [ ] RED：`go test ./internal/reader -run 'TestNative(Loop|Session)' -count=1`（server目录）。预期当前Pi分支/缺失nativeLoop失败。
- [ ] 抽取现有 Go API 循环为 runNativeLoop；单文献活动状态以versioned native connection key保存，完整回答/证据/窗口/审计沿用一次事务。原始历史与跨provider可见记录保留；api_stream/api_agent中全部SessionID路径用同一native循环；未支持工具/图片时用已有文字辅助而非假称可看图。
- [ ] GREEN：上述焦点 + `go test ./internal/reader -run 'Test(Document|API|Chat)'`、`pnpm exec vitest run apps/web/src/chat/chat-session.test.ts apps/web/src/chat/streaming-lifecycle.test.tsx`、typecheck；提交 `feat(ai): own native model and document tool sessions`。

## Task 3: 全功能用途路由与外部 Agent/Pi 退役

**Files:** Create `native_ai_generation.go`、`native_ai_lifecycle.go`、`native_ai_generation_test.go`、`scripts/native-ai-runtime.test.ts`；Modify `generation.go`、`model_defaults.go`、`translation_codex.go`（替换为 `translation_api.go`）、`translation_batch.go`、`document_overview_generation.go`、`formula.go`、`organization.go`、`image_chat.go`、`ai.go`、`diagnostics.go`、`server.go`、`document_management.go`、`document_reading.go`、`chat_context.go`、`chat_sessions.go`、`bilingual_pdf_translation.go`、`apps/desktop/main/index.ts`、`scripts/{dev,package,package-smoke}.mjs`、`package.json`、`pnpm-lock.yaml`、`apps/web/src/{CommandLineSettings,ProviderIdentity}.tsx`、`chat/{AssistantPanel,AnswerActions}.tsx`。先迁出共享生命周期/证据代码，再删除 `apps/server/internal/reader/{codex,codex_chat,codex_document,codex_handoff,document_codex_session,claude,cli,pi_agent}.go` 中已退役实现、`apps/agent`、`apps/desktop/main/agent-path.ts`、`apps/web/src/chat/CodexHandoffButton.tsx` 及对应专用测试；保留 `cli_api.go`/`cmd/reader` 这一独立的Reader客户端，不按文件名含cli就机械删除。

**Interfaces:** `(*Server).nativeGenerationService(config NativeAIConfig,task modelTask) (*GenerationService,error)`；`nativeTranslationSession` 保持顺序批次复用与close；将 `Server.Close()` 从codex_chat.go迁至native_ai_lifecycle.go，保留document task cancel/join与双语清理；以后所有AI调用只消费NativeAIConfig/snapshot。`GenerationService.Generate`/ProviderEvent调用侧签名保留；research用途默认chat模型。

- [ ] 写 `TestNativeTasksWithoutAgentRuntimes`：仅有本地mock API、PATH中codex/claude/kimi为一调用就记录失败的trap、READER_AGENT不存在；聊天/多会话、翻译、概要、公式/图片、分类、双语preflight/start都成功，无trap。`TestNativeCloseJoinsAllAIIO` 在删除/close/迁移边界阻塞API，断言返回前已join，无迟到保存。
- [ ] 写 runtime packaging test：build/dev/desktop/package引用闭包不含READER_AGENT、@reader/agent或pi依赖；仍传READER_NODE/processor及字体。测试旧CLI历史可读、legacy JSON只能迁移，CmdReader普通CLI/API不丢失，模型/额度失败不触发任何外部fallback。
- [ ] RED：`go test ./internal/reader -run 'TestNative(Tasks|Close)' -count=1`；`pnpm exec vitest run scripts/native-ai-runtime.test.ts`，预期现有硬断言/CLI/Pi/资源引用失败。
- [ ] 将所有用途迁到nativeGenerationService并移除Task1桥；替换translationService对codexChatAdapter的类型断言；保留有效stream/protocol/数据保全测试，删除仅证明已退役特性的测试。更新用量provider显示、HTTP诊断脱敏及SSE/CLI说明，移除Codex handoff按钮和安装路径探测。将双语验收脚本配置步骤适配version2，保留所有实际PDF断言。
- [ ] GREEN：上述焦点、`go test ./...`、`pnpm exec vitest run scripts/native-ai-runtime.test.ts apps/web/src/ai/ai-settings.test.tsx apps/web/src/BilingualPDFExport.test.tsx`、typecheck；检查prod依赖图和build脚本，提交 `refactor(ai): retire external Agent and Pi runtimes`。

## Task 4: 主题研究存储、范围快照与资料变更

**Files:** Create `research_types.go`、`research_migration.go`、`research_store.go`、`research_scope.go`、`research_routes.go`、`research_scope_test.go`、`research_migration_test.go`、`packages/reader-core/src/research.ts`、`packages/api-client/src/research.ts`；Modify `store.go`、`libraries.go`、`paper_items.go`、`merge.go`、`document_management.go`、`server.go`、core index/OpenAPI/generated schema。

**Interfaces:** 定义B中所有实体存储类型，先交付topic/session CRUD与快照；共享snapshotResearchScope、`(*Store).migrateResearch() error`、`(*Store).invalidateResearchDocument(ctx context.Context,documentID,reason string) error`。后者取消/清理的Server协调在Task6接上，Task4先实现事务失效。现有 `changeLibraryLabels('folders')` 的同一资料事务更新研究绑定，不另造重复分类API。

- [ ] 写 `TestResearchScopeMembersAndRevisions`：子文件夹开/关、非活动文献、一个PaperItem多个原文/译文附件、仅元数据、无可读原件、不确定两个原文时的明确选择；相同内容的范围重算revision稳定；原文替换/成员变化使revision不同。原文选择顺序：原文primary→唯一其他可读original；多个候选不猜译本或随机附件，标unavailable并给原因。
- [ ] 写 `TestResearchFolderRenameDeleteAndPaperMerge` 与migration测试：大小写/子路径匹配沿用library分类语义，rename保持topicID，删除分类只detached而保留报告；Paper合并redirect去重、引用键不写回；永久删源清掉可读取payload并标removed但其他报告仍在。初始化/重复迁移/失败回滚不改变旧表/文件/笔记。
- [ ] RED：`go test ./internal/reader -run 'TestResearch(Scope|Folder|Migration)' -count=1`。
- [ ] 实现12表迁移、索引/唯一约束及topic/session CRUD；快照在一致数据库读事务中解析成员，在校验原文版本后存入研究表；数据变更与研究失效处于同一事务/提交协议。避免外键删除原文时清除跨论文用户成果。
- [ ] GREEN：上述焦点、`go test ./internal/reader -run 'Test(Paper|Library|Research)'`、api:generate/typecheck；提交 `feat(research): persist topics and versioned paper scopes`。

## Task 5: 跨论文读工具与可复用证据条目

**Files:** Create `research_tools.go`、`research_evidence.go`、`research_cards.go`、`research_tools_test.go`、`research_cards_test.go`；Modify `document_corpus.go`、`document_tools.go`、`native_ai_tools.go`、`research_store.go`、`research_routes.go`（sources读接口）。

**Interfaces:** 实现B中researchTools/analyzeResearchPaper；`(*Server).validateResearchSources(ctx context.Context,runID string,sourceIDs []string) error`、`(*Server).resolveResearchSource(ctx context.Context,sourceID string) (ResearchEvidence,error)`。本地工具定义只含snapshot成员，来源ID是opaque全局ID，块ID只是某篇内定位。

- [ ] 写 `TestResearchToolsIsolateSameBlockIDs`：两篇PDF均有p1-b1，证据ID不同；越范围paperId与伪造sourceId拒绝；跨PDF/EPUB定位不互换；FTS查询绑定参数；页图仅视觉能力可用时注册。大结果返回nextCursor，不把未读片段记已读。
- [ ] 写 `TestResearchCardsCoverageCacheAndInvalidation`：fulltext/abstract/metadata分级、不同模型/提示/原文hash不能命中旧卡；冲突论文结论各有自己的证据；源删除/替换后cache拒读。无工具模型由Reader先检索/按页读原文再提供有来源的文字辅助，不取消主题研究能力。
- [ ] RED：`go test ./internal/reader -run 'TestResearch(Tools|Cards)' -count=1`。
- [ ] 实现按snapshot过滤的FTS5查询/逐篇公平排序，复用现有corpus与PDF/Readium定位；论文过长以cursor分片提取证据条目并合并，仅保存完成且校验的字段；来源缺失或事实字段只靠标题则失败/明确metadata。正文/页图读取注册beginDocumentTask并在完成后release。
- [ ] GREEN：焦点加现有 `TestDocumentTools`、native loop tests、typecheck；提交 `feat(research): read scoped papers with traceable evidence`。

## Task 6: 持久任务、主题综述与断线继续

**Files:** Create `research_jobs.go`、`research_events.go`、`research_reports.go`、`research_lifecycle.go`、`research_jobs_test.go`、`research_lifecycle_test.go`；Modify `research_store.go`、`research_routes.go`、`server.go`、`native_ai_lifecycle.go`、`document_management.go`、`library_location.go`（仅必要失效钩子），OpenAPI/client。

**Interfaces:** 实现create/get/controlResearchRun与events/report/markdown路由；`(*Server).composeResearchReport(ctx context.Context,runID string) (ResearchReport,error)`、`(*Server).createResearchReportRevision(ctx context.Context,parentID,requestID,content string) (ResearchReport,error)`；`(*Server).stopResearch(ctx context.Context) error` 与 `(*Server).cancelResearchForDocument(ctx context.Context,documentID string) error`。overview/compare/question均调用共用的native loop和scope证据。Task8追加网络阶段，Task9追加ideas/novelty，不另建第二种job系统。

- [ ] 写 `TestResearchRunIdempotencyAndLostResponse`：同session+userMessageId+body返回同run，改变body409；create不调用模型，start重复不重复执行；start响应丢失经GET取回completed报告。`TestResearchResumeSuccessfulUnits`：预算耗尽/主动pause/cancel/重启interrupted，已成功paper单元不重算；首次resume很快再次paused后，重试相同control requestId也不再开预算；新requestId的显式resume才做剩余单元，旧成功报告保留。`TestResearchUserReportRevision`：编辑保存新版本且不调用模型，旧版不变，用户版本清楚标识、未知引用不能变成可信跳转。
- [ ] 写 `TestResearchLifecycleCommitBarrier`：close/删除/迁移在HTTP、读页图、最终保存前取消并join；worker不在持有任务注册时反取importMu，不造成delete→join→importMu循环。新文献/模型/快照变化继续旧run返回409，旧部分证据保留为历史但不混入；页面SSE断开不自动取消显式后台run。
- [ ] RED：`go test ./internal/reader -run 'TestResearch(Run|Resume|Lifecycle)' -count=1`。
- [ ] 依共享预算实现持久状态机、两槽调度器/每topic唯一活动run、成功单元事务及事件序号；用户问题先持久化且同请求复用。运行中事件可暂存受8MiB上限约束，断线读当前snapshot/后续事件；超过可回放窗口给reset状态让客户端读报告，不重启生成。报告/来源/会话窗口/成功消息在一次事务提交，done在commit后发送。
- [ ] GREEN：焦点race `go test -race ./internal/reader -run 'TestResearch(Run|Resume|Lifecycle)' -count=1`、Go相关suite/api:generate/typecheck；提交 `feat(research): run resumable topic reviews with durable reports`。

## Task 7: 公共论文搜索、读取与网络边界

**Files:** Create `apps/server/internal/scholar/{search,public_http,rate_limit}.go` 与同名 `_test.go`；Modify `scholar.go`、`sources.go`，保留既有按标识符导入；新增 `apps/server/internal/reader/research_remote.go`、`research_remote_test.go`。

**Interfaces:** 实现 C 中 Search/FetchPublic/Candidate/PublicResource 与公开资料客户端，后续Task8调用。`(*Server).readResearchRemote(ctx context.Context,runID,candidateID string) ([]ResearchEvidence,error)`：只读取经检索登记或用户明确给出的候选URL，在owned work目录中解析；公开PDF可走现有processor/corpus底层，但不调用会创建PaperItem的import API。优先同标识符本地已存在原文并重查版本。

- [ ] 写 `TestScholarSearchPaginationIdentityAndVersions`：arXiv Atom/Crossref JSON分页、日期过滤/未知日期、相同DOI/版本arXiv去重与版本保留；同名不同作者/DOI不自动合并；响应200但正文错误/截断/超大小/畸形分页须失败。合法空数组与网络错误可区分。
- [ ] 写 `TestPublicFetchRejectsResolvedPrivateTargets`：hostname初次公网后重绑私网、IPv4/IPv6/映射IPv4、redirect、userinfo/非HTTP协议被拒，真实dial不能落内网；模型API仍可localhost。测试无Authorization/x-api-key泄漏、正文限额按解压后计、HTML主动内容移除、PDF真实签名/解析错误和abstract-only降级。
- [ ] 写 `TestScholarGlobalLimiterAndCancel`：两个run共用arXiv单槽/至少3秒；Crossref Retry-After与最多2次重试计入预算；关闭/取消中断排队和body读；使用注入clock而非让suite真实睡眠。代理为用户可信出口时不得将其localhost误判成论文目标；最终目标必须固定在已验证公网IP（含CONNECT路径），不能证明时明确失败而非绕过校验。
- [ ] RED：`cd apps/server && go test ./internal/scholar ./internal/reader -run 'Test(ScholarSearch|ScholarGlobal|PublicFetch|ResearchRemote)' -count=1`。
- [ ] 实现Go标准库HTTP/XML/JSON适配器、规范化、限速、取消和owned缓存，补现有scholar仅检查字面IP而未固定实际dial的缺口。缓存用URL/标识符/内容hash，存fetchedAt/版本；临时PDF不作为书库文献，正常下载保留安全目录和解析生命周期。普通检索缓存/查新刷新按共享合同执行，不默认调用S2等未登记来源。
- [ ] GREEN：上述焦点与旧 `go test ./internal/scholar`、typecheck；提交 `feat(research): search and read public scholarly sources`。

## Task 8: 按需联网工具、候选导入与跨域来源

**Files:** Create `research_network.go`、`research_candidates.go`、`research_network_test.go`、`research_candidates_test.go`；Modify `research_tools.go`、`research_evidence.go`、`research_jobs.go`、`research_reports.go`、`research_routes.go`、`server.go`、现有文献导入事务边界、OpenAPI/client。

**Interfaces:** 实现 C 中setResearchNetwork/importResearchCandidate，注册search_papers_online/read_online_paper；Query/来源过滤只在Task7接口执行，不复制请求器。`ResearchSearch`记录每个来源真实状态；`ResearchEvidence.candidateId`与本地paperId映射明确。许可由session状态+run allow-task/deny+当前许可generation判定，deny总是优先；关闭联网撤销当前session所有allow-task许可，并阻止工具排队中的新请求。

- [ ] 写 `TestResearchNetworkPermissionAndRevocation`：默认本地overview/query没有任何搜索HTTP；用户allow-task才可联网；文献或模型工具参数不能开启；关闭时取消/join，迟到response不能写成已读证据，其他本地卡/历史仍保留。用户显式urls可安全登记/读取，模型任意URL不行；query只发必要关键词，不发源PDF/私密笔记/模型Key。
- [ ] 写 `TestResearchCandidatesDoNotImportUntilChosen`：搜索/读取前后PaperItem、Document和citationKey不变，用户显式import才新增/去重；相同requestId重复返回同Document，原主附件不变，同名不同论文不误并。导入后删除本地原件，旧candidate不得通过缓存绕过失效；不同topic的candidate ID不能导入/读取。
- [ ] 写 `TestResearchRemoteEvidenceLevels`：网页摘要、HTML全文、PDF页保留真实层级/位置，跨论文同块ID不串联；429/一个源失败保留成功源且report列出不足，来源ID并非模型任意URL。候选PDF下载取消/退出/迁移会join，不出现迟到导入。
- [ ] RED：`go test ./internal/reader -run 'TestResearch(Network|Candidates|RemoteEvidence)' -count=1`。
- [ ] 扩展已有job与nativeToolset，不建第二套调度；search/read请求在执行前及提交前再查许可/资料；搜索日志不保存密钥，导入记录按requestId事务去重。search result只可生成候选，不给模型write/import/delete工具。
- [ ] GREEN：上述焦点race、scholar suite、api:generate/typecheck；提交 `feat(research): connect authorized online evidence and candidate imports`。

## Task 9: 有证据的 idea 探索与创新性对比

**Files:** Create `research_ideas.go`、`research_novelty.go`、`research_prompts.go`、`research_ideas_test.go`、`research_novelty_test.go`；Modify `research_jobs.go`、`research_reports.go`、`research_types.go`、core研究类型/OpenAPI/client。

**Interfaces:** 实现C中exploreResearchIdeas/checkResearchNovelty/validateNoveltyReport；idea和novelty作为同一ResearchRun.mode的阶段，成功结构结果写入research_units，再形成ResearchReport。报告引用仅来自本run已读或同版本已验证的缓存证据；从旧报告复制的引用须重新验证，不当作模型已读。

- [ ] 写 `TestResearchIdeasHaveMechanismAndFalsification`：确定性mock输出3个候选，均有problem/mechanism/hypotheses/changes/minimumExperiment/baselines/ablations/falsification/resources；空洞标题/无证据归因/缺实验字段使该单元失败且旧结果保留；明确未知资源可用unknown，不造GPU/费用数字。用户选择一个idea后可继续精化而不重跑所有已成功论文卡。
- [ ] 写 `TestResearchNoveltyFindsKnownOverlap`：本地A提出技术X，联网B全文已覆盖X；真实mock搜索和读取路径生成high_overlap并列出B的已读片段，不能仍输出not_found。新增同义词/机制/相邻领域的3类查询，至少两个来源，记录日期/过滤和排除理由。
- [ ] 写 `TestResearchNoveltyInsufficientEvidence`：仅摘要、失败源、未覆盖查询或超预算时，方法/实验claim为insufficient或显示未完成；不能因标题不相似给新颖保证。`not_found`只表示计划查询均执行成功且未发现可支持重合的证据；不等于证明创新。非法/未读citation、绝对原创/伪造概率结论被结构验证拒绝或明确要求修订，不保存成功报告。
- [ ] RED：`go test ./internal/reader -run 'TestResearch(Ideas|Novelty)' -count=1`。
- [ ] 用受约束JSON输出明确分开论文事实/推断/待验假设；后台执行有预算的真实查询计划，补读后生成逐claim对比。无function-calling模型仍可由Reader运行固定检索/读取流水线和结构化模型步骤，UI标为文字检索辅助；不伪装其有工具或视觉能力。联网未授权则给本地范围结论和启用入口，不悄悄提升权限。
- [ ] GREEN：上述焦点、Tasks5—8相关研究suite、api:generate/typecheck；提交 `feat(research): ground idea exploration and novelty checks in evidence`。

## Task 10: 主题研究界面、编辑导出和失败恢复

**Files:** Create `apps/web/src/research/{ResearchPanel,ResearchChat,ResearchProgress,ResearchReport,ResearchSources,ResearchCandidates,ResearchScope}.tsx`、`research-session.ts`、`research-panel.test.tsx`、`research-lifecycle.test.tsx`、`research-sources.test.tsx`；Modify `apps/web/src/papers/{PaperLibrary,PaperSidebar}.tsx`、`papers/state.ts`、`Workspace.tsx`（仅研究入口/跨文献导航）、`chat/MessageMarkdown.tsx`（仅可复用引用渲染钩子）、`packages/api-client/src/research.ts`；必要的后端修订/Markdown导出在Task6已有接口中完善。

**Interfaces:** `ResearchPanel({topicId:string,onOpenDocument:(documentId:string,location:DocumentLocation)=>Promise<void>})`；研究session registry按topicId/sessionId/runId隔离，subscribe GET不创建工作；ResearchSources先GET /sources验证再导航。Markdown/用户编辑使用ResearchReport修订接口；候选导入只来自用户点击。遵守现有真实packages/ui按钮/对话框/输入/切换组件，主题风格/缩放/减少动态保持一致。

- [ ] 写 `sends once and recovers the same research after start response loss`：mock create返回run、start执行后reject，GET返回running/completed，可读报告，create/start各一次；GET也失败显示查询重试，禁止自动POST。SSE重复after序号不重复正文，done丢失时查同run/消息，不重新调用模型。
- [ ] 写 `switches topics without mixing evidence or canceling explicit background work`：同名论文/同source标签在不同topic不混；切页/卸载取消订阅，后台run仍可重新订阅，取消按钮才control cancel；普通短问答stop行为与后台区别明确。双击/库迁移/过期回包受session身份约束；暂停/中断/预算触顶显示剩余篇目与继续动作。
- [ ] 写 `renders source coverage, revision history and authorized candidate import`：仅摘要/失效来源不导航为PDF，跨论文定位正确；未知引用不成链接；旧报告在新run失败后仍可读；用户编辑新修订标用户编辑且旧版不变，导出Markdown不执行raw HTML或远程图片；失效来源仍可编辑用户笔记。metadata-only/空文件夹/全部解析失败/无工具与无视觉状态均可行动。
- [ ] RED：`pnpm exec vitest run apps/web/src/research/research-panel.test.tsx apps/web/src/research/research-lifecycle.test.tsx apps/web/src/research/research-sources.test.tsx`。
- [ ] 实现文件夹「主题研究」入口、会话/范围/联网开关、真实阶段/coverage、报告/idea/查新表、来源与候选。发送/开始研究是一次用户动作，可顺序create→start，无额外每工具确认；明确联网动作发送allow-task，普通发送用inherit。保存编辑产生新版本，追问可用已有研究上下文修订。UI不显示内部SDK/临时路径或给模型任意权限的选项；多主题背景状态在已有任务入口可找到。
- [ ] GREEN：上述焦点、`pnpm exec vitest run apps/web/src/papers/paper-library.test.tsx apps/web/src/workspace-export.test.tsx apps/web/src/BilingualPDFExport.test.tsx`、typecheck；提交 `feat(research): expose topic reviews and evidence-backed idea workflows`。

## Task 11: 无外部运行时端到端验收与 WSL 预览

**Files:** Create `scripts/native-ai-research-acceptance/{run.sh,fixtures.mjs,acceptance.py,inspect.mjs}`、`docs/native-ai.md`、`docs/topic-research.md`、`docs/native-ai-research-validation.md`；Modify `docs/{agent-streaming-contract,implementation/document-conversations,native-bilingual-pdf}.md`、`docs/cli.md`、必要根README/旧Agent指南索引、`.gitattributes`（新WSL脚本LF）。辅助WSL脚本/产物在E:，不提交PDF/DB/二进制。

**Interfaces:** `bash scripts/native-ai-research-acceptance/run.sh /absolute/outside-repository/directory` 以已构建应用、鉴权loopback API、owned临时库运行；目录先canonicalize并拒绝repo/其子目录。result.json记录implementationCommit、模型/搜索mock计数、研究范围/来源/报告、保全hash和检查结果；生成可读Markdown研究样本及样本PDF，标准工具检查实际文件。

- [ ] 先写失败的acceptance断言及可复现fixture：主题内A/B/C三篇PDF（A含原文+译文附件；A/B同块名但结论冲突；C的方法被远程B2覆盖）、子文件夹一篇EPUB、一篇仅元数据文献；另有回收站/范围外文献。活动范围默认5篇，关闭子级为4；另用40篇小文献验证分批覆盖不只取前N篇。远程fixture有arXiv/Crossref分页、同名不同ID、正式版/预印本、仅摘要及限流错误。
- [ ] RED：先运行focused harness模式 `bash scripts/native-ai-research-acceptance/run.sh OUT --checks-only`（脚本需支持该标志且不自动修fixture）。未实现的真实链路断言应失败；已有成功功能不人为改错求RED。此前TDD已证明的路径记录引用，不再重复制造失败。
- [ ] 完成实际链路：v1迁移→无Agent/Pi启动→API角色设置→单篇原文引用问答/图片与翻译→主题快照→overview/compare→pause/resume与source变化→查新已覆盖/证据不足→候选明确导入去重→编辑/导出→restart/close/move/delete边界。trap外部CLI、READER_AGENT不存在、真实PDF processor仍可用。保存前后比较非空问答/笔记/批注/译文/引用键和原始SHA，不能只测空库。模型输出确定性mock，不冒充真实语言质量。
- [ ] 跑最终 `pnpm typecheck`、`pnpm test`、`pnpm build`；再运行新acceptance到 `E:/WSL/reader-native-ai-acceptance-final` 和现有 `scripts/bilingual-pdf-acceptance/run.sh` 到独立新目录，保持两种PDF布局/公式/字体/9pt/附件/取消全部既有断言。重开PDF并用Poppler渲染、实际查看所有样本页；研究样本核对引用与已知冲突/重合结论。报告全部exit/status、skips/warnings及实际commit，不重复绿灯suite除非产品源码变化或具体疑问。
- [ ] 在用户明确授权的搜索功能范围内做低频arXiv/Crossref在线可用性烟测（各一个小查询，遵守限速、无私人文献/密钥）；失败记录真实状态，不将mock当在线通过。真实模型API只用用户另行提供的配置；无Key时说明质量仍人工验证，不读取外部凭据。
- [ ] 建立独立WSL profile/library和 `E:/Administrator/Desktop/Reader 内置 AI 研究预览.lnk`，启动最终Electron/Go，核对路径/进程/健康接口/HTML、无外部Agent/Pi运行、样本与API测试Key已清空。给用户API设置、文件夹综述、联网查新、来源回跳、预算继续和两种PDF导出人工步骤；禁止浏览器自动化界面验收，不修改真实Reader启动器/库。
- [ ] 文档记录本轮范围、旧配置/历史迁移、模型Key仅本地保护、联网关键词外发/公开资料范围、摘要/全文与创新性不确定、预算及失败恢复；报告mock/在线/实际OS对话框边界。检查最终diff只含该任务内容，提交 `test(research): verify native AI workflows and isolated WSL preview`。最后完成当前执行方式要求的全分支独立审查及任何修复验证，整体验收通过才报告功能完成。

## 测试断言锚点

以下代码是每项TDD测试的关键断言片段（变量由该项所述fixture产生，使用现有testing/Vitest，不为这些断言引入新框架）；其他列举的边界仍须覆盖。

| Task | 新测试必须实际观察的断言示例 |
| --- | --- |
| 1 | `if strings.Contains(string(publicJSON), "sk-test-secret") || !got.Connection.HasKey { t.Fatal(got) }`；换端点后 `got.Connection.HasKey == false` |
| 2 | 截断/未知工具后 `savedAnswers == 0 && fallbackCalls == 0`；完整stop后恰好一次保存，旧thread/piEntries从未被传到模型 |
| 3 | `if len(agentTrapCalls) != 0 { t.Fatal(agentTrapCalls) }`；依次执行所有用途后实际API记录均有正确role/model |
| 4 | fixture默认 `len(snapshot.Members) == 3`（原文+译本的A、子级EPUB的B、metadata的C；回收站D不含），关闭子级为2，rename前后topic.ID相同 |
| 5 | `if a.ID == b.ID || a.PaperID == b.PaperID { t.Fatal(a,b) }`；两条来源均来自各自p1-b1，非成员读取失败 |
| 6 | 3篇/预算2的读取阶段 `got.Status == "paused" && got.Done == 2 && modelCalls == 2`；继续后完成剩余，前两单元调用次数仍各1 |
| 7 | `if privateDialed || leakedAuthorization { t.Fatal("unsafe public fetch") }`；fake clock观察arXiv并发1、间隔>=3s，取消排队无下一请求 |
| 8 | 搜索/补读前后 `paperCount == beforePaperCount`；显式import重复requestId同documentID，撤销许可后 `lateEvidenceWrites == 0` |
| 9 | 已覆盖fixture `rows[0].Status == "high_overlap"` 且引用B2全文；相同claim只给摘要时 `Status == "insufficient"` |
| 10 | `expect(api.startResearchRun).toHaveBeenCalledTimes(1)`；丢响应后GET恢复、报告可读；卸载重开不再POST，同topic间引用不混 |
| 11 | 默认活动范围5、40篇分批全部有覆盖条目、所有陷阱调用0、真实读回文件/报告满足断言；保全快照逐行相同 |

## 自检与需求追踪

| 已确认设计要求 | 归属任务/最终证据 |
| --- | --- |
| API-only配置/角色/Key/旧配置 | 1；3清桥；11迁移与无Agent端到端 |
| 自有会话/工具/严格流/上下文/历史 | 2；3退役；10断线UI；11全量/实际API |
| 现有问答/概要/分类/翻译/图片/双语PDF | 3用途测试；11原双语真实产物完整回归 |
| 主题稳定身份/子级/多附件/元数据/版本 | 4范围事务；5证据；11可重现实验范围 |
| 跨论文引用/页图/EPUB/摘要与全文 | 5；8远程；10来源导航；11混合fixture |
| 全范围分批/成功缓存/增量/预算 | 5卡片；6任务；10继续；11四十篇及源变更 |
| arXiv/Crossref真实搜索/安全读取/限流 | 7；8权限与集成；11mock及在线烟测分开 |
| 不自动导入/稳定key/去重/删除失效 | 4、8；11非空数据保全 |
| idea机制/假设/最小实验/消融/失败条件 | 9结构与证据测试；10可展开；11样本 |
| 创新性重合/不足/检索审计，不保证原创 | 8日志；9已覆盖与摘要失败fixture；11实际对比 |
| 持久任务/幂等/响应丢失/暂停继续/重启 | 6、10；11 HTTP端到端 |
| 删除/迁移/退出join/无死锁/保全成功成果 | 3、4、6、7、8；11竞态与非空快照 |
| 保存/用户修订/导出/新资料使旧报告stale | 4、6、10；11报告历史与文件读回 |
| 克制UI/shadcn/非浏览器验收/WSL预览 | 1、10；11人工预览及使用说明 |
| 不读外部凭据/不发版/不动真实库/独立提交 | 全局约束，11最终diff/runtime/数据证据 |

已完成计划自检：设计全部章节已映射到上表；11项均具文件/接口、RED与GREEN命令及提交边界；统一模型/任务/来源类型，修正了控制请求幂等键、跨范围图片类型和用户报告修订协议；5项Review Focus各有归属测试。正文以接口/断言而非函数实现为主；未发现未归属设计要求。上述检查是文档完整性检查，不是应用测试通过声明。

接口以共享合同为准，不能在后任务另起同义字段/状态机。预算为工程默认参数，可依实际证据微调但需记录理由；不能调整为静默遗漏论文、放宽来源验证或偷偷恢复外部Agent。当前计划只定义实施工作，代码与运行验收将在执行阶段产生。
