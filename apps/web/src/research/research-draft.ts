/** Extract the visible content string from a still-incomplete report section.
 * Drafts are never treated as saved/validated reports. */
export function researchDraftText(raw: string) {
  if (!raw.trimStart().startsWith("{")) return raw;
  const start = /"content"\s*:\s*"/.exec(raw);
  if (!start) return "";
  let text = "";
  for (let i = start.index + start[0].length; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"') break;
    if (char !== "\\") {
      text += char;
      continue;
    }
    const escaped = raw[++i];
    if (escaped === undefined) break;
    if (escaped === "u") {
      const hex = raw.slice(i + 1, i + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      text += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else {
      const escapes: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      if (!(escaped in escapes)) break;
      text += escapes[escaped];
    }
  }
  return text;
}
