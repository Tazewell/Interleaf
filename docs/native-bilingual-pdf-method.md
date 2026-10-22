# 原生双语 PDF 的准备与组合方法

Reader 的实现使用 PDF.js 6.3.289、PDF-LIB 1.17.1、`@pdf-lib/fontkit` 1.1.1 和已有原生 Canvas；没有 PDF2zh、BabelDOC、Zotero 或 ONNX 导出依赖。现有 ONNX 版面解析构建保持原样；导出只消费已存在的 manifest。

算法研究参考了 [PDFMathTranslate 固定版本的 converter.py](https://github.com/PDFMathTranslate/PDFMathTranslate/blob/7fd3bb7a2ce22f8e584ceb9d744e2a3a63684987/pdf2zh/converter.py)、同版本 `high_level.py` 和 `translator.py`：区域组织段落、数学占位、真实字宽折行、还原公式和先降低行距的方法。实现为独立 TypeScript 代码，没有复制上游 AGPL 源码。Reader 用原始公式像素和严格失败替代公式重建及宽松占位符处理。

## 准备协议

`prepareNativePDF({input,layout,fromPage?,toPage?})` 的 `layout` 是既有 `schemaVersion:1` manifest 文件路径；校验 `inputSHA256`、总页数、区域 ID 和归一化 bounds，直接从原 PDF 获取文字。`prepared.revision` 是原始 manifest **字节**的 SHA-256，仅表示版面快照；`originalSha256` 表示原文身份。段落 `sourceHash` 独立计算于 `reader-native-pdf-v1`、原生段 ID、带占位符源文、物理 bounds 和公式 bounds，不复用阅读译文的 hash。最终任务身份还需调用方冻结导出器/字体版本、目标译文及 options。

所有 bounds 使用 PDF.js 可见页面的物理点，顶左原点，已经处理可见 CropBox 与 MediaBox 的交集、旋转和 UserUnit。原文面板通过剪裁 Form XObject、CropBox 平移及旋转/UserUnit 变换保持原尺寸。不会复制文档 JavaScript、页面动作或批注；译文面板只有清洗后的像素背景、公式图像和新文字层。

可翻译区域为摘要、正文、标题、独立图题、旁注及脚注。表格内部、图内文字、代码/算法、参考文献、独立公式等保留原像素。现有解析器会将图/表题并入资产的 `caption`；导出在资产内按去空白后的实际 PDF 字形内容唯一定位它，再生成独立图题段落。找不到、多处匹配、切在 TextItem 内部或与图内文字混叠时明确报错。图题 `blockId` 仍是原资产 ID，`originalSource` 保持 manifest caption。

相交的同栏脚注只在导出准备阶段合并为一段，保留首块 `blockId`；合并 ID 包含组成员摘要，源文和 hash 覆盖全部脚注。合并后继续检查其他正文/图表冲突，不改阅读 manifest 或已有译文。源字体的 ascent/descent 外沿会纳入擦除区域；检测框细边只有经字形或 300 DPI 空白像素证明可安全切开才收窄。其他破坏性重叠使任务失败。

## 公式与排版

PDF.js 原始字体名称取自已加载的字体对象，字宽取自 `showText` 字形 advance。数学字体、数学 Unicode、上/下标、等式等被保护；合并 TextItem 中的普通文字和公式按真实 advance 拆开。相邻数学片段及上下标组成一个 crop；明确的 inline_formula 区域整体裁取，以保留分数横线等路径。`{v0}` 等段内占位符必须完整且恰好出现一次，未知/重复/缺失或非法括号均阻止输出。模型不生成 LaTeX。

字体为随应用打包的 Noto Sans SC 固定原文件，详情见 `apps/processor/fonts/README.md`。排版使用常规字重 400 实例的 advance、glyph bbox 和 Unicode 覆盖集。CJK 可逐字折行，Latin 单词与空白保留，过长单词可拆分；公式的真实宽高参与行适配。先将行距从 1.4 降至 1.0，再以 0.5 pt 尝试缩小，最后必试 9 pt；正文不低于 9 pt。不会向未经证实的空白区扩展。排不下就报告页码和段落 ID，不裁掉正文或暗换原文。

译文背景按固定 300 DPI、关闭批注绘制逐页渲染；先取公式 crop，再擦除本页翻译区域、放入中文和新位置公式。一次只持有一页 raster；单边超过 16,384 px 或整页超过 40,000,000 px 会报带页码的错误，不降低分辨率。原文原尺寸矢量面板与译文页面尺寸一致；并排 N→N、宽 2W+12 pt，交替 N→2N。无可翻译横排文字的页必须明确保留；无 OCR。

## CLI 和失败边界

CLI：`--stage prepare --input PDF --layout MANIFEST --prepared JSON [--from N --to N]`；`--stage render --input PDF --prepared JSON --targets JSON --output PDF --mode side-by-side|alternating [--keep-original 2,4]`。

路径由 Go 任务持有，渲染的 prepared/targets/output 必须在同一任务目录；拒绝符号链接输出目录、非普通文件输出和覆盖输入。prepared/output 先写同目录随机临时文件，再原子重命名。CLI 不接触 API 或密钥，stdout 为逐行 `{stage,done,total}`；错误写 stderr、非零退出。调用方负责创建/清理任务目录以及取消并等待进程退出。

当前边界：横排文字层；不支持 OCR、竖排或侧向文字翻译，不能可靠定位的公式/图题或有内容重叠会失败。检测框之外的未归属文字按原图保留并在 warnings 中告知。没有内容语义识别器去发现完全没有数学字体/符号/大小线索的公式；需要可靠现有版面和文字层。中文输出可搜索，保留的公式/图表像素不附加隐藏英文文字层。

## 验证方式

`apps/processor/src/bilingual-pdf/engine.test.ts` 使用程序生成的真实 PDF 和真实内置字体，覆盖页数/范围/混合尺寸、CropBox/四种旋转/UserUnit 非对称标记、中文子集回读、动作/批注清洗、缺字、公式令牌与上下标/分数横线、双栏/图题/图像保留、脚注合并、9 pt 与溢出、像素上限、无字页及 CLI 原子失败。

额外用真实论文 _Attention Is All You Need_ 的前六页和 Reader 实际 manifest 做准备及短中文+原占位符的 mock 排版探针，用 Poppler 的 `pdfinfo`、`pdffonts`、`pdftotext` 和页面 PNG 检查。mock 只证明几何/字体/流程，不代表真实 API 翻译质量。无需浏览器自动验收；人工应打开导出 PDF 核对原文清晰度、图表内文字、图/表题、脚注、公式及中文复制搜索。
