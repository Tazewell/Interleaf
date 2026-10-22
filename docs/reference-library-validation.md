# 文献管理第一阶段验证记录

日期：2026-10-22。实现分支：`codex/reference-library-design`。本记录覆盖实现至 `7abd8c9`；后续仅修改文档不影响以下代码验证结果。

## 自动验证

在 Ubuntu WSL 的完整 Linux 依赖环境运行，发行版存放于 E 盘。使用原生测试目录 `/home/admin/.cache/reader-reference-check`；584 个源码文件与实现工作树核对一致（仅忽略 CRLF/LF 差异）。

- `pnpm typecheck`：通过。
- `pnpm test`：通过，Go 全部包通过；Vitest 164 个文件、1094 项测试通过，3 个文件、5 项测试沿用原有跳过。
- `pnpm build`：通过。保留已有的 Vite 大分块提示，没有把提示当作构建失败。
- 单独验证新增的迁移、元数据权威来源、附件生命周期、引用键、导入冲突、宏和 crossref、导出文件保护与桌面授权测试；修复均有先失败后通过的回归记录。
- Windows 大小写不敏感目录与 Linux 大小写敏感目录分别验证导出目标别名，拒绝同一文件被重复管理，同时允许 Linux 上两个不同的大小写路径。
- 真实服务、鉴权 HTTP、临时 SQLite 书库：23 项检查通过，覆盖 PDF 重复导入、混合 EPUB 书籍、无附件文献、合并字段事务回滚、附件独立笔记/批注/进度、稳定引用键、BibTeX/BibLaTeX 依赖、自动更新、外部编辑保护、移出/回收/恢复与重启。
- 通过真实 HTTP 导出的含机构作者、宏和 crossref 的 `.bib`，分别完成 `pdflatex -no-shell-escape` + BibTeX/Biber + 两轮 pdflatex 编译。

最终日志位于 WSL 的 `/home/admin/.cache/reader-reference-final-typecheck.log`、`reader-reference-final-test.log`、`reader-reference-build.log` 和 `reader-reference-final-acceptance.log`。它们是本机测试产物，不加入版本控制。

## 桌面预览与人工验收

桌面快捷方式：`E:\Administrator\Desktop\Reader 文献管理预览.lnk`。启动脚本：`E:\WSL\reader-reference-preview.sh`。

预览使用 `/home/admin/.cache/reader-reference-preview` 下的独立配置和临时书库；未迁移或修改原有 Reader 书库。已确认 Reader 窗口、本地鉴权 API 与网页资源正常启动。没有使用浏览器自动化做视觉验收。

界面外观、实际操作体验及自己的 Overleaf 项目上传需要人工检查，步骤见 [使用指南](reference-library.md#人工验收步骤)。本地自动导出只更新授权的本地文件，Overleaf 仍需手动上传更新。

## 实施中的取舍

- 用户已批准设计及实现测试，沿用该授权推进，没有重复要求计划确认；若范围理解有误，改动仍在独立分支中可复核和撤回。
- 解析器和原生导出路径校验在互不重叠的文件中先行准备；代价是接口改变时需局部适配，已通过集成验证。
- 遇到损坏或符号链接形式的迁移前快照时停止升级并保留快照；代价是需要先处理无效快照，避免把不可信备份当作恢复点。
- 文件夹改名使自动导出目标跟随，删除文件夹则暂停并保留最后文件；增加少量生命周期状态，防止仅因分类操作清空写作参考文献。
- 合并的冲突字段选择与附件和引用键在同一事务中保存；增加了受限的合并 patch 接口，避免客户端分两次请求造成部分成功。

分支保留供复核，未合并到主分支，也未推送。
