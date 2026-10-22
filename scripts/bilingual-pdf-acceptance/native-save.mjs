// Exercise the production main-process helper with real HTTP and file I/O.
// The injected chooser is intentional: this does not automate an OS picker.
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const p = JSON.parse(raw);
const { BilingualPDFSaveService } = await import(pathToFileURL(p.helper));
const frame = { url: p.url },
  contents = { mainFrame: frame };
let suggested;
const service = new BilingualPDFSaveService({
  context: () => ({
    contents,
    appURL: p.url,
    serverURL: p.url,
    token: p.token,
    library: p.library,
    available: true,
  }),
  choose: async (name) => {
    suggested = name;
    return p.cancel ? null : p.path;
  },
  fetch: (url, init) => fetch(url, init),
});
try {
  const result = await service.save(
    { sender: contents, senderFrame: frame },
    { documentId: p.documentId, jobId: p.jobId },
  );
  assert.equal(result.saved, !p.cancel);
  if (!p.cancel)
    assert.match(suggested, p.mode === "alternating" ? /交替/ : /并排/);
  console.log(JSON.stringify({ result, suggested }));
} finally {
  await service.stop();
}
