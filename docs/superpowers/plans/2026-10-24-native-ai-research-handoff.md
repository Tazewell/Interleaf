# 内置 AI 研究：已完成验收

2026-10-28：用户授权的三个剩余问题均已修复并通过独立限定复审；最终产品提交 `9ad8614`。Tasks 1～11、61项要求已核对。最新结果、提交、验证、局限及完整复审见[最终集成记录](2026-10-28-native-ai-research-completion.md)。本次仅本地main集成，没有推送或发布。

以下为2026-10-26及此前的阶段历史，包含已失效的待办、PID、禁止合并等当时状态，不作为当前执行指令。忽略目录审计材料归档于 `E:/WSL/reader-native-ai-audit-2026-10-28/audit.zip`。

---

# 内置 AI 研究：实施进度与剩余待办

本文件最初用于第 8 项后的换会话交接。**2026-10-26 最新状态：Tasks 1～10 已完成阶段实施与独立审查；Task 11 的完整检查、实际产物和隔离预览已执行，但最终限定复审仍有 I1、I3、I7 三项 Important，整体验收未通过。** 后文 Task 8～10 的“接续位置”和 Task 11 待办是阶段历史，当前状态以本节及[最终复审报告](2026-10-26-native-ai-research-final-review.md)为准。

## 当前阻断与交付状态（2026-10-26）

- 当前产品提交：`f0ae338b895196323a6d44259e22089a9d80cf22`，分支 `codex/native-ai-research`；本次收尾只新增审查交接文档。
- 原完整分支审查覆盖 `d64f41a..d8071c3`，提出 7 个 Important；统一修复范围 `d8071c3..f0ae338` 共 11 个提交、24 个路径。唯一一次限定复审关闭 I2/I4/I5/I6，I1/I3/I7 保持阻断；没有再发起第二修复波次。
- I1：常见原创概率句式仍可绕过成功校验，例如“原创性概率95%”“The probability of originality is 95%”。必须在保留普通科学百分比的同时修复。
- I3：结构化摘要中的 Methods/Results 可被扁平文本分类器当成全文。必须在失去 HTML 结构前确认正文身份，否则保持未确认，不能满足查新全文门槛。此残余由源码推导，尚未新增实际 HTTP 反例。
- I7：停服超时后实际 close、或服务已非零退出，失败 Promise 被永久缓存；再次退出仍被拦截。必须区分清理结果与进程已关闭状态，保留取消/join 和失败不迁移、不重启约束。
- `pnpm typecheck`、`pnpm test`、`pnpm build` 在最终产品源码上均 exit 0；Go 全套通过，Vitest 170 文件通过、3 文件跳过，1225 测试通过、5 跳过。根检查和原验收没有覆盖上述三个残余，不构成豁免。
- 新原生验收 `E:/WSL/reader-native-ai-final-fix-acceptance-v2`：20 项通过、40 篇覆盖、69 次受控模型调用、外部 Agent trap 0、非空历史保全。最终研究 PDF 6 页全部渲染、查看、重开；既有双语 4 个 PDF 共 15 页检查保留。受控工程验收不证明真实模型的科学质量。
- 最终检查、source/mirror/HEAD 字节绑定及退出记录：`E:/WSL/reader-native-ai-logs/final-review-fix/v2`。完整执行台账、独立报告和反例保留于本工作树 `.superpowers/sdd/2026-10-22-native-ai-research/`；因为未通过，不删除该审计目录。
- 独立样本预览：`E:/Administrator/Desktop/Interleaf 内置 AI 研究预览.lnk`；人工步骤见 `docs/native-ai-research-validation.md`。样本连接的 endpoint/Key 已清空，用户自行填写。当前为 Linux WSLg 开发预览，未验收 Windows 安装包/原生对话框。
- 主检出 `D:/work/myreader/reader` 保持 `main` / `d64f41a` 干净；没有 push、merge、发布、改版本或构建安装器，也没有访问真实书库或外部凭据。

后续需用户明确授权第二轮修复，再只处理这三个已确认缺口及必要验证，使用同一工作树，保留所有原检查和失败记录。不得按旧“继续 Task 11”文字重新执行已经完成的 Tasks 1～10，也不得把 Task 11 或整体目标标为完成。

## 接续位置

- 唯一实施工作树：`C:/Users/Administrator/.codex/worktrees/native-ai-research/reader`。
- 分支：`codex/native-ai-research`。保留主检出 `D:/work/myreader/reader`，不要把待办直接在主检出重做。
- 设计依据：`docs/superpowers/specs/2026-10-22-native-ai-research-design.md`。
- 完整计划及共享接口：`docs/superpowers/plans/2026-10-22-native-ai-research.md`。
- 本轮实现起点：`3c2cac2f4f3f8b9199f202ae8dd95dc64ae2cc37`（台账记录，包含既有双语 PDF 基线 `1fb835d`）；最终审查必须覆盖整个本轮实现，不仅最后一项提交。
- 任务台账：`.superpowers/sdd/2026-10-22-native-ai-research/progress.md`。
- 完成证据：同目录 `completion-evidence.md`。该目录被 Git 忽略，当前机器保留；切换机器时不能假设它存在。
- Tasks 8～10 的提交、审查结论及当前接续位置：见本文件末尾。

开始新对话时先核对 `git status --short --branch`、`git log`、`AGENTS.md` 和可能存在的 `AGENTS.local.md`；台账和实际源码优先于旧摘要。Tasks 1～10 已完成阶段实施与审查，不要重派；第 11 项当前只剩最终复审的三个阻断及修复后的验证。不要把本文件当成最终整体验收已完成的证据。

## 全程约束

- 中文沟通，按项实施，实施代理不得再派子代理；每项完成后由控制者派独立审查，修复后限定复审，最后做全分支审查。
- AI 仅使用用户显式配置的 API 地址、Key 和模型；保留 Interleaf 自有会话、工具循环和任务，不恢复外部 Agent/Pi。不得读取 Codex/Claude 或其它工具的凭据。
- 本地综述默认不搜索公网；会话联网许可、单次许可和撤销规则继续生效。模型或论文内容不能授予网络权限。
- 搜索结果只是候选；显式用户导入才改变书库。原文、译文、批注、问答、报告和引用键必须保全。
- 完整响应及结构/来源校验通过后才提交成功；已显示部分输出后不追加备用答案。成功持久化后才能发送 done。
- PDF 保留页/块位置；EPUB 保留原生章节/位置；摘要、HTML、PDF 全文证据不可混用。
- 一项任务采用同一既有调度、预算、暂停/继续、取消/join 协议，不另建研究任务引擎。
- 小步 Conventional Commit；精确暂存及检查，不 `git add -A`，不提交 `.reader`、PDF/DB、模型、二进制或依赖目录。不推送、合并、发布。
- 最终必须运行 `pnpm typecheck`、`pnpm test`、`pnpm build`。禁止浏览器自动化作视觉验收，提供独立预览与人工步骤。

### Task 8 已采用、后续必须保留的接口裁定

- 用户显式点击候选导入是一次新的下载/导入授权，即使原研究 run 已完成或会话当前 networkAllowed=false 也可发起；它不恢复旧 allow-task，不开始/继续模型工作。
- 该操作绑定候选最近一次有效成功搜索/用户 URL 登记所属会话的当前许可 generation（多次登记按 created_at/id 稳定排序），持久记录 provenance；之后撤销许可、请求中止、退出或迁移必须取消并 join 在途操作。已提交 requestId 重试直接回放结果，不重复网络 I/O。
- 不允许 foreign/forged/removed 登记，也不允许旧候选恢复已删除来源。当前导入 API 无 session 字段，最近登记会话可能不同于用户当前可见会话；这是已记录的设计代价，未来若新增 session 字段须另作明确接口变更。
- candidate 的纯 PaperID/DocumentID 映射不改变既有远端内容 hash；真实元数据/可用性变化仍需使旧证据和报告失效，保留历史正文。
- 已验证本地原文在冻结主题范围外时，可按已登记候选读取并保留 candidate/local provenance，但不扩展 snapshot、coverage 或普通本地论文工具权限。原文被删除后不能退回旧远程缓存恢复可读内容。
- 公共资料的展示 URL 去掉全部 query/fragment；原始 operational URL 仅内部登记/传输。沿用 `public-evidence-v2`，不把旧 v1 缓存当有效证据。
- 复用现有 `search_papers_online` / `read_online_paper`，后者仅接受已登记 candidateId。不得为 Task 9 另建任意 URL 抓取器或绕过 Task 8 的预算、登记及许可检查。
- Crossref 协议已依据官方 2026-08-24 升级公告及后续补充校正：cursor 不再过期，每页改变，后续请求携带相同 query 参数，索引变化会影响结果集。旧“五分钟过期”草稿不能成为实现或测试要求。核对记录见 `task-7-protocol-grounding.md`。

## Task 9：有证据的 idea 探索与创新性对比

### 实现工作

1. 新增 `apps/server/internal/reader/research_ideas.go`、`research_novelty.go`、`research_prompts.go` 及对应测试；扩展既有 jobs/reports/types、core 类型、OpenAPI 和 API client。
2. 实现 `exploreResearchIdeas(ctx, runID)`、`checkResearchNovelty(ctx, runID, ideaID)` 和 `validateNoveltyReport(...)`。沿用同一个 ResearchRun，将结构化成功单元写入 `research_units`，最终形成 ResearchReport。
3. 默认生成 3 个 idea，允许用户指定 1～3 个；每个包含问题、机制、假设、具体改动、最近工作、最小实验、基线、消融、证伪条件、资源和逐条 claim。事实、推断、待验证假设明确区分；未知资源标 unknown，不能编造 GPU/费用。
4. 支持针对明确 idea 的继续精化，并复用当前版本已成功的论文卡，不重做所有论文分析。旧报告引用须重新验证，不能因历史文本存在就视为模型已读。
5. Interleaf 执行有预算的检索计划：同义词、机制、相邻领域三类查询，使用 arXiv 与 Crossref；记录真实查询、来源、日期、过滤、失败和排除理由。补读真实候选内容后，再逐 claim 对比。
6. 每条 claim 返回 `high_overlap`、`partial_overlap`、`not_found` 或 `insufficient`，附 relatedWorkIds/evidenceIds、重合、差异与未验证项；总报告含 queryIds/asOf/coverage/caveats。
7. 方法/实验只有摘要或查询失败、覆盖不足、超预算时必须标不足/未完成。`not_found` 仅表示计划查询成功完成后没有发现支持重合的证据，不代表原创证明。拒绝未读引用、绝对原创或伪造概率。
8. 联网未授权时给本地范围结论和启用入口。无 function-calling 模型仍由 Interleaf 执行固定检索/结构化步骤，诚实展示能力；不伪装工具或视觉能力。
9. 预算耗尽保留已生成候选、成功查询和已核查项；继续任务沿用既有检查点、来源版本、累计调用和所有权屏障。

### 必须验证

- `TestResearchIdeasHaveMechanismAndFalsification`：3 个完整候选；空洞/缺字段/无证据归因拒绝且旧结果保留；选择精化不重跑已成功论文卡。
- `TestResearchNoveltyFindsKnownOverlap`：实际 mock HTTP 搜索和读取链路取得 B2 全文；B2 已覆盖 X 时输出 high_overlap，并引用确实读过的片段。只伪造模型 JSON 不算通过。
- `TestResearchNoveltyInsufficientEvidence`：同一方法 claim 只给摘要时 insufficient；失败源、未覆盖查询、超预算不能变成 not_found；非法引用/原创保证不保存为成功报告。
- 先运行 RED：`go test ./internal/reader -run 'TestResearch(Ideas|Novelty)' -count=1`，再实现并查看实际 GREEN。
- 运行 Tasks 5～8 相关研究回归、`pnpm api:generate`、`pnpm typecheck`；报告准确命令、退出状态及 mock 边界。
- 独立审查完整 Task 9 提交范围，修复并限定复审；建议提交 `feat(research): ground idea exploration and novelty checks in evidence`。

接续材料：`.superpowers/sdd/2026-10-22-native-ai-research/task-9-context-draft.md`、`task-9-review-context.md`。这些是早期草稿，必须先用已接受 Task 8 源码重核接口，尤其 executeResearch 的 mode guard、模型 snapshot/usage、来源 allowlist 和远程获取阶段。

## Task 10：主题研究界面、编辑导出和失败恢复

### 实现工作

1. 新增 `apps/web/src/research/` 下 ResearchPanel、ResearchChat、ResearchProgress、ResearchReport、ResearchSources、ResearchCandidates、ResearchScope、research-session 及三组测试。
2. 从现有 PaperSidebar/PaperLibrary 增加文件夹“主题研究”入口，接入真实 topic/session/run；必要时调整 App/Workspace 的导航连接，不把主题伪装成 Document，也不重排整个书库。
3. 使用项目 `packages/ui` 现有 primitives，保持 light/dark/system、缩放、键盘交互与减少动态；不暴露 SDK、临时路径或任意模型权限开关。
4. 展示会话、范围、联网开关、真实阶段和全范围 coverage、报告、可展开 idea/查新表、来源和候选；元数据、缺原文、空范围、解析失败和能力不足状态均提供可执行下一步。
5. registry 按 topicId/sessionId/runId 隔离。订阅只 GET，不创建工作；一次用户发送可 create→start，普通发送 inherit，明确联网动作 allow-task，候选仅用户点击导入。
6. start 响应丢失时查询同一个 run；GET 失败提供查询重试，不自动再 POST。SSE 按序号去重，done 丢失时查持久状态。
7. 切主题/卸载只取消订阅，显式后台任务继续；用户取消才调用 cancel。暂停/预算触顶展示剩余工作及继续动作，避免与普通短问答停止语义混淆。
8. 点击引用先 GET `/sources/{id}` 验证，再按真实 documentId/native location 导航。摘要/失效来源不能猜成 PDF 页，未知引用不生成链接。
9. 编辑报告调用 revisions 产生用户新版本，旧版不覆盖；旧报告在新任务失败后仍可读，失效来源不妨碍编辑用户笔记。Markdown 导出不执行 raw HTML 或远程图片，不自动下载/改书库。

### 必须验证

- `sends once and recovers the same research after start response loss`：create/start 各一次；丢响应后 GET 恢复；GET 再失败也不自动 POST；重开只订阅。
- `switches topics without mixing evidence or canceling explicit background work`：同名论文/同标签来源跨主题不串；过期回包、双击、迁移和取消受身份约束。
- `renders source coverage, revision history and authorized candidate import`：原生位置、摘要/失效/未知来源、旧报告与用户修订保全、显式导入、无工具/视觉/原文等状态。
- 焦点命令：`pnpm exec vitest run apps/web/src/research/research-panel.test.tsx apps/web/src/research/research-lifecycle.test.tsx apps/web/src/research/research-sources.test.tsx`。
- 再跑 `paper-library.test.tsx`、`workspace-export.test.tsx`、`BilingualPDFExport.test.tsx` 和 typecheck；独立审查及必要限定复审。
- 建议提交 `feat(research): expose topic reviews and evidence-backed idea workflows`。

接续材料：同一 SDD 目录的 `task-10-context-draft.md`。先核对 Task 9 最终 API/类型；UI 不可用成功形状的 stub 代替后端行为。

## Task 11：完整验收、WSL 预览与全分支审查

### 自动化验收与真实产物

1. 新建 `scripts/native-ai-research-acceptance/{run.sh,fixtures.mjs,acceptance.py,inspect.mjs}`，输出目录 canonicalize 后拒绝仓库及其子目录；使用已构建应用、鉴权 loopback API 和任务自有临时库。
2. 夹具：主题 A/B/C PDF，A 同时有原文和译文，A/B 同块名但结论冲突，C 方法被远程 B2 覆盖；子目录 EPUB、仅元数据文献、回收站及范围外文献。默认范围 5、关闭子级 4；另 40 篇验证全量分批覆盖。远端含分页、同名不同 ID、预印本/正式版、摘要及限流错误。
3. 支持 `run.sh OUT --checks-only`；新增尚未实现的真实断言先 RED，已有路径不人为改坏求 RED，也不重复制造已证明的失败。
4. 验收 v1 迁移→无 Agent/Pi 启动→API 角色→单篇原文问答/图片/翻译→overview/compare→暂停继续/源变更→查新重合与证据不足→显式导入去重→编辑导出→重启/退出/迁移/删除。
5. PATH 设置外部 CLI trap，READER_AGENT 不存在；确认真实 PDF processor 可用。比较非空旧问答、笔记、批注、译文、引用键和原始文件 SHA 的前后快照，空库不能证明保全。
6. `result.json` 记录 implementationCommit、模型/搜索 mock 调用计数、范围、来源、报告、保全 hash 和断言结果；生成可读 Markdown 研究样本及样本 PDF，读取实际产物核查。
7. 最终运行 `pnpm typecheck`、`pnpm test`、`pnpm build`。研究验收输出 `E:/WSL/reader-native-ai-acceptance-final`，既有双语验收输出另一个独立目录。
8. 双语验收保留两种布局、公式、字体、最小 9pt、附件和取消断言；用 Poppler 渲染并实际查看全部样本页，重新打开 PDF。研究样本检查冲突、重合、证据与引用。
9. arXiv/Crossref 各一个低频小查询作真实在线烟测，不发送私人文献或 Key；真实失败如实记录，mock 不算在线通过。真实模型只用用户另行提供的配置，无 Key 不读取别处凭据、不声称语言质量验收。

### WSL 与预览的具体环境

- 专用镜像 `/home/admin/.cache/reader-native-ai-check`；同步脚本 `E:/WSL/reader-native-ai-sync.sh`。先检查脚本仍只同步本 worktree。
- WSL PATH：`/home/admin/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`。依赖安装显式用 `/mnt/d/.pnpm-store`，不在 C 盘新建默认 store/node_modules。
- 先前完整 processor build 曾因 HuggingFace DNS 失败；单独 corpus worker 构建通过不等于完整 build 通过。
- 已知可复核缓存：`/home/admin/.cache/reader-reference-check/apps/processor/models/PP-DocLayoutV3-FP16-58dfa00ba1135e027817cbd5802f1f0df62aa5c0.onnx`，67372587 bytes，SHA256 `8bb693ed3b5dcc1cf926b15d89dfe6abf62bc11cdd0afd33c8ffe039db6f8209`。先核对最终 model.json 和实际 hash，再复制到专用镜像；不得修改 reference/预期 hash、绕过验证或提交模型。
- sync 的 `--delete` 未排除 models，必须在最后一次 sync 后再放入已验证模型；后续 sync 后若模型被清掉，按同样流程恢复，不误判为产品故障。
- 桌面入口 `apps/desktop/main/index.ts`，构建入口 `apps/desktop/dist/main.cjs`；Electron 启动 `apps/desktop/bin/reader-server`、生成 token、loopback port 0、绑定 activeLibrary。
- 使用任务自有 XDG_CONFIG_HOME/cache/profile/library，实际核对 Electron appData/userData。`READER_DATA` 不是桌面库覆盖，`scripts/dev.mjs` 硬编码仓库 `.reader`/17840，不适合最终隔离预览。
- 新建 `E:/Administrator/Desktop/Interleaf 内置 AI 研究预览.lnk`，不改真实启动器/库。核对 Electron/Go 路径、进程、健康/鉴权 API/HTML，无外部 Agent/Pi 进程；移除样本测试 Key。
- 提供人工操作步骤：API 设置、文件夹综述、联网找论文/查新、来源回跳、预算继续、编辑导出、两种双语 PDF。禁止浏览器自动化视觉验收。

### 待处理审查债务与文档

- Task 3：runtime guard 要同时覆盖实际退役的 `@earendil-works/pi-*` 与旧 namespace；OpenAPI chat 描述需与原生无 fallback/后台订阅语义一致。
- Task 4：unavailable revision 的原始诊断路径散列、早期 CorpusBackground 启动失败归因及旧镜像 apps/agent 缓存警告，按原审查及当前源码查实。不要把仍在处理的旧草稿文字当成当前 blocker。
- Task 6 M1：真实 SQLite report-INSERT 屏障测试中补 trash/paper-trash/pause 的 HTTP 成功及持久终态断言，保留取消/join、无迟到报告和旧历史保全断言。
- Task 8 审查的直接覆盖限制：新增测试没有单独阻塞共享同步 `pdfPageCount` 阶段，也没有直接执行候选导入中的桌面迁移。代码已由控制者定点核对：import owner 纳入 beginAIIO/Close join，提交前检查 ctx；桌面 migrateLibrary 等 stopLibraryServer 成功退出后才复制，30 秒超时拒绝迁移。Task 11 仍须验证实际候选导入/计页/迁移组合，不把代码检查说成已执行的组合验收。
- Task 1 曾记录 workspace-export React duplicate-key 警告；以最终测试实际输出核验，需修复时独立处理。Task 8 的新审查债务如有，收尾后补下方。
- 所有权一致性和 ideaCount 早期问题已有后续修复记录；新写入仍须独立负例，不能宣称早期通过覆盖未来实现。
- 编写 `docs/native-ai.md`、`docs/topic-research.md`、`docs/native-ai-research-validation.md`，同步 streaming/conversations/bilingual/CLI/README 索引，记录迁移、Key 本地保护、关键词外发、证据级别、创新性不确定性、预算及恢复。
- 记录实际命令、退出状态、skip/warning、提交与 mock/在线/OS 人工边界；仅源码变化或具体未解疑问才重复已绿套件。
- Task 11 独立审查后做整分支最高能力独立审查、统一修复与限定复审；最后逐要求查完成证据。未完成或证据不足就不能宣布整个目标完成。
- 建议提交 `test(research): verify native AI workflows and isolated WSL preview`；独立的债务修复另作逻辑提交。

接续材料：`task-11-context-draft.md`、历次审查和 completion-evidence。Task 11 草稿含历史 pending 描述，必须结合台账核验，不能重做已经关闭的修复。

## 可复制给新对话的接续指令

先读 `C:/Users/Administrator/.codex/worktrees/native-ai-research/reader/docs/superpowers/plans/2026-10-24-native-ai-research-handoff.md` 的最新状态及同目录 `2026-10-26-native-ai-research-final-review.md`，核对工作树、分支、Git 状态与台账。Tasks 1～10 不重派；Task 11 的根检查、产物、联网烟测、预览、全分支审查和唯一限定复审均已执行，但 I1/I3/I7 仍为 Important。只有用户明确授权第二轮修复后，才在现有工作树处理这三个缺口及必要验证。保留 `D:/work/myreader/reader`，不推送/合并/发布、不读外部凭据、不动真实书库；WSL 使用现有专用镜像。不因旧交接文字重跑未改变的绿色套件，不把工程检查通过当成整体完成。

## Task 8 验收记录（2026-10-24）

- Task 8 主体：`2d18346`，接通授权联网证据和显式候选导入。
- 第一轮修复：`11fc12c` 精确限制候选元数据失效范围；`be69ee4` 在普通候选读取失败时保留成功证据并继续报告。相关集成 race 的历史实际结果为 exit 0、68.351 秒。
- 原实施会话在第二个修复提交后、追加最终修复报告前中断。新会话已从原工具输出恢复 `task-8-fix-1-recovery.md`，并派独立限定复审。
- 第一轮复审另复现负检查点遮住后来导入本地原件的问题；第二轮修复 `529f8bc` 已补入正式回归，读取失败后导入可读原件可以在同 run 使用本地证据，当前不足说明随成功验证更新，历史记录与远程证据版本保留。
- 第二轮正式回归经历 RED→GREEN；最终相关 Network/Candidates/Remote race exit 0、44.954 秒，318/318 源/镜像原始字节及更改的 HEAD blob 由独立复审再次核对。`task-8-rereview-2.md` 判定唯一新增 Important 已解决且无新问题，Task 8 阶段审查完成。
- Task 8 验收时产品提交为 `529f8bc`。最终完整应用检查、实际产物和隔离预览仍属于 Task 11；导入计页与桌面迁移组合等既有覆盖限制仍须实测。
- 详细进度、实际命令和审查结论以当前机器的 `.superpowers/sdd/2026-10-22-native-ai-research/progress.md` 及对应报告为准。

## Task 9 验收与当前接续位置（2026-10-24）

- 主体提交 `3da8729`：有来源归因的 idea、逐主张创新性对比、实际有界双源查询计划和已读证据校验。查询/模型/读取沿用既有任务、预算和事务。
- 第一轮修复：`cdf4b1b` 重映射所选历史 idea 的合法行内引用；`0db1914` 在 idea/查新中实际读取用户显式授权链接；`fe49c92` 按真实模型窗口连续分批、保存成功检查点并在预算暂停后继续，保留全部来源范围。
- 第二轮修复 `bb64f8c`：远端证据参与 idea 模型时持有当前许可 lease，撤权取消并等待；正式分批/非分批测试确保迟到响应不保存成功模型/批次/idea。纯本地 deny 和 candidate-local 保持本地语义。
- 首次独立审查及两轮限定复审均已记录；`task-9-rereview-2.md` 关闭最后唯一 Important，未发现新问题。最终相关 Ideas/Novelty 测试 exit 0、7.704 秒，撤权/生命周期 race exit 0、18.549 秒；更早最终 Research 回归 18.656 秒、scholar 0.452 秒、API 生成/typecheck 均 exit 0。复审准确区分报告中的执行输出和后来已不存在的 `/tmp` 原始日志，没有重复运行绿色套件。
- 只读 `researchAPI.getResults(runId, signal?)` 返回 `ideas`、`partialIdeas`、`novelty`、`queries`、`pendingIdeaIds`、`batches` 和 `capability: text-search-assistance`。批次计数是来源片段分析进度，不能称作论文全文覆盖率；部分 idea 不能当作最终可选候选。Go/core/OpenAPI/generated client 已一致。
- Task 10 从当前已接受产品提交 `bb64f8c` 后接续；优先读生成的 `task-10-brief.md` 与当前接入材料 `task-10-context.md`，不要重做 Task 9。Task 10 需要独立完整审查；Task 11 的根检查、实际产物、在线来源烟测、隔离预览和全分支审查均未完成。
- 本阶段使用受控 HTTP 模型/论文夹具；工程测试不证明真实模型的科学推理或原创性。尚无用户另行提供的真实模型配置，不读取外部凭据或真实书库补足验证。

## Task 10 验收与当前接续位置（2026-10-25）

- 主体提交 `9fb82c6` 接入真实研究界面、会话 registry、报告修订和来源；`70e26dc` 接入论文库入口、物理库 epoch 与原生跨文献导航。create/start 不确定后仅 GET 恢复；卸载不取消后台研究；候选只在显式操作后导入。
- 第一轮修复 `7f85a44` 在同一健康 SSE 上串行读取持久进度；`a217818` 将报告操作归属与草稿按会话/版本隔离，固定编辑基版，避免后台新报告打断用户笔记。
- 第二轮修复 `bd54fdd` 为同一 run 的整批读取增加顺序保护，在终结事件让步前使旧批次失效，避免迟到的 run/results/关联刷新覆盖最终状态。正式回归包含迟到 run、results 与 refresh，旧响应忽略 abort 也不能改写。
- 完整审查的 3 个 Important 和限定复审的新竞态均已关闭；`task-10-rereview-2.md` 判定唯一新增 N1 已解决，无新问题。最终受影响研究界面 37/37、typecheck exit 0；未改部分较早的集成 71/71、聊天/Markdown 49/49 保留，不冒称重复执行。完整 23 文件源/已测镜像/HEAD 原始 bytes 一致。
- 两个 Minor 留给 Task 11/全分支收尾：来源详情需增加可读论文/候选出处；原有 export-doc duplicate-key 测试警告需查明并修复，不能过滤日志。
- 当前产品提交 `bd54fdd961f8db14fbf2e5da0953d4281092b320`，接续 Task 11。当前接入材料是 `task-11-context.md`，旧 `task-11-context-draft.md` 仅留历史。完整根检查、实际样本及 PDF 重读/逐页查看、真实来源烟测、独立 WSL 预览和全分支审查仍未完成；不宣布整体交付。
