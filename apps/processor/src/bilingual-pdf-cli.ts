import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";
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
        "reading",
        "reading-metadata",
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
  if (values.reading !== undefined && values.reading !== "true")
    throw new Error("阅读模式参数无效");
  if (values.stage !== "render" && values["reading-metadata"])
    throw new Error("阅读元数据仅用于生成阶段");
  const page = (value: string | undefined) => {
    if (value === undefined) return undefined;
    if (!/^[1-9]\d*$/.test(value) || Number(value) > 1_000_000)
      throw new Error("页码参数无效");
    return Number(value);
  };
  const progress = (event: { stage: string; done: number; total: number }) =>
    process.stdout.write(JSON.stringify(event) + "\n");
  const pathKey = (path: string) => {
    const absolute = resolve(path);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  const safeOutput = async (path: string, inputs: string[]) => {
    if (inputs.some((v) => pathKey(v) === pathKey(path)))
      throw new Error("输出不能覆盖任务输入");
    const directory = dirname(path),
      actual = await realpath(directory);
    if (pathKey(actual) !== pathKey(directory))
      throw new Error("任务输出目录不能是符号链接");
    try {
      const destination = await lstat(path, { bigint: true });
      if (!destination.isFile()) throw new Error("输出路径不是普通文件");
      for (const input of inputs) {
        try {
          const source = await stat(input, { bigint: true });
          if (
            destination.ino !== 0n &&
            destination.ino === source.ino &&
            destination.dev === source.dev
          )
            throw new Error("输出不能覆盖任务输入");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
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
      reading: values.reading === "true",
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
      pathKey(dirname(prepared)) !== pathKey(dirname(output)) ||
      pathKey(dirname(targets)) !== pathKey(dirname(output))
    )
      throw new Error("准备数据、译文及输出必须位于同一任务目录");
    await safeOutput(output, [input, prepared, targets]);
    const mode = required("mode");
    const reading = values.reading === "true";
    if (
      mode !== "side-by-side" &&
      mode !== "alternating" &&
      !(reading && mode === "translation-only")
    )
      throw new Error("输出模式无效");
    let metadata: string | undefined;
    if (reading) {
      if (mode === "alternating") throw new Error("阅读模式不支持交替页面");
      metadata = resolve(required("reading-metadata"));
      if (pathKey(dirname(metadata)) !== pathKey(dirname(output)))
        throw new Error("阅读元数据及输出必须位于同一任务目录");
      await safeOutput(metadata, [input, prepared, targets, output]);
    } else if (values["reading-metadata"] !== undefined)
      throw new Error("阅读元数据需要启用阅读模式");
    const keepOriginalPages =
      values["keep-original"] === undefined
        ? []
        : values["keep-original"].split(",").map((v) => page(v)!);
    const report = await renderNativePDF(
      {
        input,
        output,
        layout: mode,
        prepared: JSON.parse((await readLimited(prepared)).toString("utf8")),
        targets: JSON.parse((await readLimited(targets)).toString("utf8")),
        keepOriginalPages,
        reading,
      },
      progress,
    );
    if (metadata) await atomicWrite(metadata, JSON.stringify(report));
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
