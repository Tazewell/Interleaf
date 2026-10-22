# 原生双语 PDF 验证记录

## 可复现回归

在已安装依赖的 Linux/WSL checkout 中运行。需要 Node、pnpm、Go、Python 3、Poppler（`pdffonts`、`pdftoppm`）；首次构建需要准备项目固定的 ONNX 模型。产物目录必须为仓库外的绝对路径。

```bash
pnpm typecheck
pnpm test
pnpm build
bash scripts/bilingual-pdf-acceptance/run.sh /absolute/output/reader-bilingual-acceptance
```

脚本不读取用户文献库或账号凭据。它生成自有 PDF，在随机临时文献库中启动回环鉴权服务及模拟翻译 API，实际调用导入、ONNX 解析、双语预检、明确开始、流式翻译、生产 PDF CLI、原生保存服务、附件事务和取消/删除接口。API 输出是确定性测试译文，不代表付费模型翻译质量。

`native-save.mjs` 注入文件选择结果，实际下载并保存文件，再与鉴权 GET 的字节比较；还检查取消选择不落文件、不挂附件。未自动操作实际系统保存选择器，人工步骤见[使用说明](native-bilingual-pdf.md)。

`inspect.mjs` 用 PDF.js 重新打开全部四份输出，检查页数、逐页物理尺寸、原文文字与顺序、可搜索中文、翻译段落没有隐藏重复英文、公式占位符未泄漏、中文字号不低于 9 pt。`pdffonts` 检查嵌入、子集和 Unicode 映射；`pdftoppm` 渲染所有输出页。**脚本的结构检查不能代替逐页查看 PNG**，也不构成真实 API 或原生系统对话框的交互验收。

## 当前执行证据

本轮最终完整检查与真实 CLI 验收的源码为 `c498aee8b49668ea6cdaa70c864f14e26d778251`（2026-10-22）：产品修复截至 `7d910cf`，包含 `65945c7` 的普通花括号/公式协议修复，以及 `7d910cf` 的开始响应中断后同任务查询恢复；`c498aee` 仅增加自有全栈样本中的花括号证据。随后文档单独提交，不将文档提交后的哈希写成已测试版本。环境为 WSL Ubuntu、Node 22.23.3、pnpm 10.30.3、Go 1.26.10、Poppler 26.01.0。

- `pnpm typecheck`：退出码 0。
- `pnpm test`：退出码 0；Go 6 个包通过（reader 包 41.228 秒，其余缓存），server command 无测试；Vitest 168 个文件、1189 个测试通过，3 个文件共 5 个测试跳过，75.26 秒。
- `pnpm build`：退出码 0；processor、Go server、web、desktop 和 connector 构建完成。构建后的 `dist/fonts/NotoSansSC.ttf` 与源字体同为 17,772,300 字节，SHA-256 `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`；fontkit patch 已应用。
- 本轮只运行一次最终全量 `wsl -d Ubuntu -- bash /mnt/e/WSL/reader-bilingual-validation.sh`，退出码 0；同步只用 `reader-bilingual-sync.sh`。完整日志和定向 TDD RED/GREEN 日志归档于 `E:\WSL\reader-bilingual-validation-c498aee`。此前 `01cbf22`、`cca8d5a` 的历史日志保留在各自目录。

跳过项为 Linux 上的 Windows 注册表安装测试 1 项、未设置 `READER_TEST_LAYOUT_MODEL` 的可选模型测试 1 项、未设置 `READER_INTEGRATION_READY` / `READER_INTEGRATION_FIXTURES` / `READER_INTEGRATION_IMAGE` 的可选聊天后端集成 3 项。本次另以真实导入覆盖 ONNX 解析，没有把这些跳过项写成通过。

测试已有输出包括：`workspace-export.test.tsx` 的 React 重复 `export-doc` key 54 次；`act(...)` 环境提示 7 次，来自 `pdf-annotations.test.ts`（3）、`pdf-blocks.test.ts`（2）、`update-progress.test.tsx`（2）；旧 `pdf-export.test.ts` 的 OffscreenCanvas 3 次、standardFontDataUrl 6 次、PDF 对象索引 2 次和 startxref 恢复 1 次。构建有 virtua PURE 注释警告 4 次和大 chunk 警告 1 次。它们未使命令失败，日志并非完全无警告。

重复 key 是真实的 React sibling identity 遗留风险（M1），可能导致复用或遗漏，需独立修复与复现回归；本次没有将它归为无害噪声。双语导出使用独立 `export-${doc.id}` key，新增区域也按文档/文献身份隔离；本轮开始恢复、查询重试、取消和卸载回归通过，尚无其破坏本次导出生命周期的具体证据。

定向回归先观察到 RED：TS 10 个新边界失败、Go 误收大小写/残缺 token 和误拒普通占位、UI 5 个同任务恢复场景失败；修复后 3 个 TS 测试文件 77 项全部通过，Go `TestBilingualPDF` 全部通过。覆盖普通/嵌套/不配对花括号、保留候选严格校验、原文 token 冲突预检失败、真实嵌入字体输出；开始已接受但响应 reject 后 GET translating→ready 并保存、GET 失败重试同一任务、仍待确认时保留原拒绝、取消/卸载期间迟到恢复不能保存。create/start 不自动重放，现有生命周期测试保留。

## 样本和生命周期覆盖

| 输入          | 真实解析与内容                                                           | 两种输出                            |
| ------------- | ------------------------------------------------------------------------ | ----------------------------------- |
| 自有论文 2 页 | 23 个 ONNX 块；单栏/双栏、跨栏标题、图、表、图表题、行内及独立公式、脚注 | 并排 2 页、交替 4 页                |
| 几何样本 3 页 | 6 个 ONNX 块；90°/270°、偏移 CropBox、UserUnit 1/1.25/1.5、混合尺寸      | 并排 3 页、交替 6 页                |
| 无文字 1 页   | 0 个块；不选保留原文时拒绝开始，明确保留后可生成                         | 生命周期负例                        |
| 极长译文      | 真实流式 API 完成后进入排版                                              | 明确失败，无 ready PDF 或可下载文件 |

几何样本的可见原页尺寸依次为 `900×675`、`680×500`、`645×885` pt。预检对第 1、2 页未归属版面的文字给出「按原图保留」警告；实际保留的标题/图内原文仍可见，不能将此描述为整页所有英文都已翻译。

回归还检查：预检零 API 调用；保存前取消不落盘；保存字节与鉴权下载相同；翻译附件属于同一 PaperItem，重复内容去重，不增加 PaperItem，主附件/引用键不变；导出、任务取消、文档删除之后，另一原文的 SHA-256、非空阅读译文、批注、文献笔记逐行不变；在真实 API 请求途中取消/删除会等待任务结束、清理临时目录，不能迟到下载或挂附件；最终隔离预览的模拟 API 地址和密钥清空。

最终执行命令为 `bash scripts/bilingual-pdf-acceptance/run.sh /mnt/e/WSL/reader-bilingual-acceptance-final`，使用原生镜像和 `GIT_DIR=/mnt/d/work/myreader/reader/.git/worktrees/reader1`、`GIT_WORK_TREE=/home/admin/.cache/reader-reference-check`，退出码 0，62 次确定性模拟 API 请求；`result.json` 的 `implementationCommit` 为上述 `c498aee` 完整 SHA。自有论文正文和 API 译文新增 `{}`、`{name}`、`{value}`、嵌套 JSON 与未闭合 `{`，两种布局都实际通过 prepare→完整 API→原生 CLI→PDF.js 可搜索文字检查，既有公式/几何与生命周期断言保留。四份文件全部通过检查，15 页由 Poppler 渲染后逐页实际查看。270° 页的跨行公式操作数 `a` 与下一行 `= b + c` 均完整保留。极长译文错误为「第 1 页段落 p1.p1-b1 排版溢出（最小字号 9 pt）」，任务为 failed，无输出文件，文件接口返回 409。

证据在 `E:\WSL\reader-bilingual-acceptance-final`，包括 `result.json`、四份 PDF、逐模式 `prepared.json` / `targets.json` / `layout.json` / `pdffonts.txt` 及 15 张 `render/page-*.png`。完整集成日志为 `E:\WSL\reader-bilingual-acceptance-final.log`。目录保护另验证了将仓库本身作为产物目录会在写入样本前以退出码 2 拒绝。

沿用的隔离预览库为 `/home/admin/.cache/reader-bilingual-preview/library-01cbf22`，该名称是持久目录名，不代表运行代码版本。它此前由成功临时库用生产 `--migrate-library` 命令复制；空的无文字负例已删除，几何原件已补回原文献并重新解析。库中仍为 2 篇文献、6 份 PDF（2 份原文主附件、4 份翻译附件），只有隔离 profile 指向它。本轮构建后已重新启动隔离桌面预览：`preview-check.json` 记录 `implementationCommit=c498aee…`，Electron/生产 server 的进程、工作目录及隔离 profile 匹配，实际 server 二进制与新构建 hash 一致，鉴权健康接口和内置 HTML 均 200，WSLg Reader 窗口 1440×940，API 地址为空、`hasKey=false`。本轮新花括号样本见上述论文的两种布局导出文件；预览沿用原测试库。没有自动点击应用界面或系统文件选择器，真实付费 API 翻译质量和 OS 选择器交互仍须人工验证。
