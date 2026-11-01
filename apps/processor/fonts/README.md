# 内置中文 PDF 字体

`NotoSansSC.ttf` 是未经修改的 Google Fonts Noto Sans SC 可变 TrueType 字体。

- 来源：[google/fonts 的固定提交](https://github.com/google/fonts/tree/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc)
- 上游文件：`ofl/notosanssc/NotoSansSC[wght].ttf`
- Git blob SHA-1：`fb0637bafbcd804fe32152370a1225990745b4bc`
- 大小：17,772,300 字节
- 授权：随附的 `OFL.txt`，SIL Open Font License 1.1

导出时再次验证原始 Git blob，使用 `@pdf-lib/fontkit` 的 `getVariation({wght:400})` 实例化常规字重，再对子集字形嵌入 PDF；不需要系统字体、联网或外部字体目录。原文件的字体名称表带有 Thin 名称，因此 PDF 子集明确命名为 `RDRNSC+NotoSansSC-Regular`，其轮廓取自 400 实例。字体的真实 advance 和 glyph bbox 用于折行和基线定位，缺字使任务失败。

`build.mjs` 把本目录完整复制到 `dist/fonts/`，与编译后的 CLI 一起打包。OFL 许可必须随字体保留。
