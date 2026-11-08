// Local diagnostic server. It never changes the selected production build.
import { createServer, request } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
export async function createReadingPerformanceServer({
  web,
  backend,
  port = 65008,
  label = "baseline",
}) {
  const upstream = new URL(backend);
  if (
    upstream.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(upstream.hostname) ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    upstream.pathname !== "/"
  )
    throw new Error("Backend must be a loopback HTTP origin");
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(label))
    throw new Error("Invalid diagnostic label");
  const root = await realpath(resolve(web));
  const inside = (path) => path === root || path.startsWith(root + sep);
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      const localPort = server.address()?.port;
      if (
        ![`127.0.0.1:${localPort}`, `localhost:${localPort}`].includes(host) ||
        (req.headers.origin && req.headers.origin !== `http://${host}`)
      ) {
        res.writeHead(403).end();
        return;
      }
      const pathname = decodeURIComponent((req.url || "/").split("?")[0]);
      if (pathname.split(/[\\/]/).includes("..") || pathname.includes("\0")) {
        res.writeHead(403).end();
        return;
      }
      if (pathname.startsWith("/api/") || pathname.startsWith("/pub/")) {
        const proxy = request(
          new URL(req.url, upstream),
          { method: req.method, headers: req.headers },
          (response) => {
            response.on("aborted", () => res.destroy());
            response.on("error", () => res.destroy());
            res.writeHead(response.statusCode || 502, response.headers);
            response.pipe(res);
          },
        );
        proxy.on("error", () => {
          if (!res.headersSent) res.writeHead(502).end();
          else res.destroy();
        });
        req.on("aborted", () => proxy.destroy());
        res.on("close", () => proxy.destroy());
        req.pipe(proxy);
        return;
      }
      if (!["GET", "HEAD"].includes(req.method)) {
        res.writeHead(405).end();
        return;
      }
      const probe =
        pathname === "/__reading-performance/overlay.js"
          ? "overlay.js"
          : pathname === "/__reading-performance/metrics.mjs"
            ? "metrics.mjs"
            : undefined;
      let path;
      if (probe)
        path = fileURLToPath(
          new URL("./reading-performance/" + probe, import.meta.url),
        );
      else {
        const candidate = resolve(
          root,
          "." + (pathname === "/" ? "/index.html" : pathname),
        );
        if (!inside(candidate)) {
          res.writeHead(403).end();
          return;
        }
        path = await realpath(candidate);
        if (!inside(path)) {
          res.writeHead(403).end();
          return;
        }
      }
      if (!(await stat(path)).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader(
        "Content-Type",
        mime[extname(path)] || "application/octet-stream",
      );
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      if (extname(path) === ".html") {
        const html = await readFile(path, "utf8");
        res.end(
          html.replace(
            "</body>",
            `<script type="module" data-reading-performance="${label}" src="/__reading-performance/overlay.js"></script></body>`,
          ),
        );
      } else
        createReadStream(path)
          .on("error", () => res.destroy())
          .pipe(res);
    } catch (error) {
      if (!res.headersSent)
        res.writeHead(
          error?.code === "ENOENT"
            ? 404
            : error instanceof URIError
              ? 400
              : 500,
        );
      res.end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  return server;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      web: { type: "string" },
      backend: { type: "string" },
      port: { type: "string", default: "65008" },
      label: { type: "string", default: "baseline" },
    },
  });
  if (!values.web || !values.backend)
    throw new Error(
      "Use --web <production-dist> --backend <loopback-origin> [--port 65008] [--label baseline]",
    );
  const server = await createReadingPerformanceServer({
    ...values,
    port: Number(values.port),
  });
  console.log(
    JSON.stringify({
      origin: `http://127.0.0.1:${server.address().port}`,
      label: values.label,
    }),
  );
}
