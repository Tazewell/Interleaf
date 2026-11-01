import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { prepareNativePDF } from "./bilingual-pdf/prepare";
import { renderNativePDF } from "./bilingual-pdf/compose";
import { atomicWrite, readLimited } from "./bilingual-pdf/runtime";

try {
  const { values } = parseArgs({
    options: Object.fromEntries(
      [
        "stage",
        "input",
        "layout",
        "prepared",
        "from",
        "to",
        "targets",
        "output",
        "mode",
        "keep-original",
      ].map((key) => [key, { type: "string" as const }]),
    ),
  });
  const required = (key: string) => {
    const v = values[key];
    if (!v) throw new Error(`缺少参数 --${key}`);
    return v;
  };
  const input = resolve(required("input")),
    prepared = resolve(required("prepared"));
  const page = (value: string | undefined) => {
    if (value === undefined) return undefined;
    if (!/^[1-9]\d*$/.test(value) || Number(value) > 1_000_000)
      throw new Error("页码参数无效");
    return Number(value);
  };
  const progress = (event: { stage: string; done: number; total: number }) =>
    process.stdout.write(JSON.stringify(event) + "\n");
  const safeOutput = async (path: string, inputs: string[]) => {
    if (inputs.some((v) => resolve(v) === path))
      throw new Error("输出不能覆盖任务输入");
    const directory = dirname(path),
      actual = await realpath(directory);
    if (resolve(actual) !== resolve(directory))
      throw new Error("任务输出目录不能是符号链接");
    try {
      if (!(await lstat(path)).isFile())
        throw new Error("输出路径不是普通文件");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  if (values.stage === "prepare") {
    const layout = resolve(required("layout"));
    await safeOutput(prepared, [input, layout]);
    progress({ stage: "prepare", done: 0, total: 1 });
    const data = await prepareNativePDF({
      input,
      layout,
      fromPage: page(values.from),
      toPage: page(values.to),
    });
    await atomicWrite(prepared, JSON.stringify(data));
    progress({
      stage: "prepare",
      done: data.pages.length,
      total: data.pages.length,
    });
  } else if (values.stage === "render") {
    const output = resolve(required("output")),
      targets = resolve(required("targets"));
    if (
      dirname(prepared) !== dirname(output) ||
      dirname(targets) !== dirname(output)
    )
      throw new Error("准备数据、译文及输出必须位于同一任务目录");
    await safeOutput(output, [input, prepared, targets]);
    const mode = required("mode");
    if (mode !== "side-by-side" && mode !== "alternating")
      throw new Error("输出模式无效");
    const keepOriginalPages =
      values["keep-original"] === undefined
        ? []
        : values["keep-original"].split(",").map((v) => page(v)!);
    await renderNativePDF(
      {
        input,
        output,
        layout: mode,
        prepared: JSON.parse((await readLimited(prepared)).toString("utf8")),
        targets: JSON.parse((await readLimited(targets)).toString("utf8")),
        keepOriginalPages,
      },
      progress,
    );
  } else throw new Error("阶段必须为 prepare 或 render");
} catch (error) {
  // Node filesystem/parser exceptions can contain private paths or document data.
  const message = error instanceof Error ? error.message : "PDF 导出失败";
  process.stderr.write(
    /^[\u3400-\u9fff]/u.test(message)
      ? message + "\n"
      : "PDF 文件、任务数据或原生依赖无效\n",
  );
  process.exitCode = 1;
}
