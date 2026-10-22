"""Isolated real HTTP/ONNX/CLI/native-save acceptance; linguistic output is mocked.

Requires a built checkout, Python stdlib, Node, Go and Poppler. Never opens a
user library. Credentials are generated test strings and never written to logs.
"""
import hashlib
import http.server
import json
import os
import re
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT, OUT = map(lambda p: Path(p).resolve(), sys.argv[1:3])
HERE = Path(__file__).resolve().parent
TARGETS = json.loads((HERE / "targets.json").read_text())
STATE = {"calls": 0, "mode": "normal", "errors": [], "requests": []}
ENTERED, RELEASE = threading.Event(), threading.Event()
KEY, MODEL = "reader-acceptance-test-key", "reader-acceptance-model"


class Mock(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"data": [{"id": MODEL}]}).encode())

    def do_POST(self):
        try:
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert self.headers.get("Authorization") == "Bearer " + KEY
            assert request["model"] == MODEL
            prompt = request["messages"][-1]["content"]
            if not isinstance(prompt, str):
                prompt = "".join(part.get("text", "") for part in prompt)
            paragraphs = json.loads(prompt.split("DOCUMENT_DATA_JSON:\n", 1)[1])
            STATE["calls"] += 1
            mode = STATE["mode"]
            STATE["requests"].extend(paragraphs)
            if mode == "blocked":
                ENTERED.set()
                assert RELEASE.wait(20), "blocked API was not released"
            result = []
            for p in paragraphs:
                # Meaningful fixture translations, with explicit geometry labels.
                if "Geometry page" in p["source"]:
                    text = "几何页面：旋转、裁切与物理单位"
                elif "horizontal paragraph" in p["source"]:
                    text = "横排段落检查裁切框偏移、页面旋转及混合物理尺寸。行内公式保留可见外观，原始矢量在导出后仍然清晰。"
                else:
                    assert p["id"] in TARGETS, p
                    text = TARGETS[p["id"]]
                tokens = re.findall(r"\{v\d+\}", p["source"])
                if tokens:
                    text += " " + " ".join(tokens)
                if mode == "overflow":
                    text = "这是一段刻意超长且不得被截断的确定性测试译文。" * 80 + " " + " ".join(tokens)
                result.append({"id": p["id"], "target": text})
            answer = json.dumps(result, ensure_ascii=False)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            # Two actual deltas, then the completion event and terminal marker.
            half = len(answer) // 2
            for text in [answer[:half], answer[half:]]:
                event = {"choices": [{"index": 0, "delta": {"content": text}}]}
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
            self.wfile.write(b'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # Expected when a running job is cancelled/deleted.
        except Exception as error:
            STATE["errors"].append(str(error))
            self.send_error(500)


def wait_for(check, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(.05)
    raise AssertionError("deadline exceeded")


mock = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Mock)
threading.Thread(target=mock.serve_forever, daemon=True).start()
run = Path(tempfile.mkdtemp(prefix="reader-bilingual-acceptance-"))
library = run / "library"
env = dict(os.environ, READER_NODE=shutil.which("node"), READER_PROCESSOR=str(ROOT / "apps/processor/dist/main.mjs"))
log = open(OUT / "server.log", "wb")
server = subprocess.Popen([str(OUT / "reader-server"), "--data", str(library), "--port", "0", "--connector=false"], cwd=run, env=env, stdout=log, stderr=log)
results = {"implementationCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(), "run": str(run), "library": str(library), "exports": [], "checks": []}
(OUT / "result.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))

try:
    def discover():
        assert server.poll() is None, "server exited"
        path = library / "server.json"
        return json.loads(path.read_text()) if path.exists() else None
    discovery = wait_for(discover)

    def api(method, path, body=None, content_type="application/json", expected=200):
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body).encode()
        req = urllib.request.Request(discovery["url"] + path, data=body, method=method, headers={"Authorization": "Bearer " + discovery["token"], "Content-Type": content_type})
        try:
            response = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            assert response.code in (expected if isinstance(expected, tuple) else (expected,)), (method, path, response.code, raw.decode(errors="replace")[:1500])
            return json.loads(raw) if raw and response.headers.get_content_type() == "application/json" else raw

    api("PUT", "/api/settings", {"autoTranslateMaxPages": 0, "autoGenerateOverview": False})
    api("PUT", "/api/ai/config", {"primary": "api", "api": {"url": f"http://127.0.0.1:{mock.server_port}", "key": KEY, "protocol": "openai"}, "translationModels": {"api": MODEL}, "models": {"api": MODEL}, "apiModels": [MODEL]})

    def imported(name):
        boundary = "ReaderAcceptanceBoundary"
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="library"\r\n\r\npapers\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: application/pdf\r\n\r\n').encode() + (OUT / name).read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        doc = api("POST", "/api/documents", body, "multipart/form-data; boundary=" + boundary, 201)
        manifest = library / "cache" / doc["id"] / "analysis/manifest.json"
        def ready():
            processing = api("GET", f'/api/documents/{doc["id"]}/assistance')
            assert processing.get("status") != "failed", processing
            return manifest.exists() and processing.get("phase") != "learning"
        wait_for(ready, 180)
        parsed = json.loads(manifest.read_text())
        assert parsed["schemaVersion"] == 1
        print("Actual ONNX imported", name, parsed["pages"], "pages", len(parsed["blocks"]), "blocks", flush=True)
        return doc

    def seed(doc):
        # Deliberately unrelated reading data verifies a non-empty preservation case.
        with sqlite3.connect(library / "reader.sqlite") as db:
            db.execute("INSERT INTO translations(document_id,block_id,source_hash,status,body) VALUES(?,?,?,?,?)", (doc["id"], "acceptance-reading", "unrelated-reading-source", "complete", json.dumps({"blockId": "acceptance-reading", "sourceHash": "unrelated-reading-source", "status": "complete", "sentences": [{"source": "Existing reading text", "target": "已存在的阅读译文"}]})))
            annotation = {"id": "acceptance-" + doc["id"], "documentId": doc["id"], "kind": "note", "note": "已存在的批注", "location": {"type": "pdf", "page": 1}, "quote": "", "color": "#facc15", "createdAt": "2026-10-22T00:00:00Z", "tags": []}
            db.execute("INSERT INTO annotations VALUES(?,?,?)", (annotation["id"], doc["id"], json.dumps(annotation)))
            db.execute("INSERT INTO document_notes VALUES(?,?,?)", (doc["id"], "已存在的文献笔记", "2026-10-22T00:00:00Z"))

    def snapshot(doc):
        with sqlite3.connect(library / "reader.sqlite") as db:
            rows = {table: db.execute(f"SELECT * FROM {table} WHERE document_id=? ORDER BY rowid", (doc["id"],)).fetchall() for table in ["translations", "translation_previous", "annotations", "document_notes"]}
            paper = db.execute("SELECT id,primary_document_id,citation_key FROM paper_items WHERE id=?", (doc["paperId"],)).fetchone()
        return {"sha256": hashlib.sha256((library / "papers" / (doc["id"] + ".pdf")).read_bytes()).hexdigest(), "rows": rows, "paper": paper}

    def preflight(doc, mode, **options):
        prefix = f'/api/documents/{doc["id"]}/bilingual-pdf'
        job = api("POST", prefix, {"layout": mode, **options}, expected=202)
        path = prefix + "/" + job["id"]
        def terminal():
            j = api("GET", path)
            return j if j["status"] in ["awaiting-confirmation", "failed"] else None
        job = wait_for(terminal)
        assert job["status"] == "awaiting-confirmation", job
        work = next(p.parent for p in (library / "export-temp/bilingual-pdf").glob("session-*/job-*/prepared.json"))
        prepared = json.loads((work / "prepared.json").read_text())
        assert job["preflight"]["apiConfigured"]
        return path, job, work, prepared

    def completed(path):
        def terminal():
            job = api("GET", path)
            return job if job["status"] in ["ready", "failed", "cancelled"] else None
        return wait_for(terminal, 180)

    def native(doc, job, mode, output, cancel=False):
        p = {"helper": str(OUT / "native-save.mjs"), "url": discovery["url"], "token": discovery["token"], "library": str(library), "documentId": doc["id"], "jobId": job["id"], "mode": mode, "path": str(output), "cancel": cancel}
        result = subprocess.check_output([env["READER_NODE"], str(HERE / "native-save.mjs")], input=json.dumps(p).encode(), cwd=run, env=env, timeout=30)
        return json.loads(result)

    paper = imported("reader-synthetic-paper.pdf")
    seed(paper)
    results["previewDocumentId"] = paper["id"]
    baseline = snapshot(paper)

    geometry = imported("reader-geometry.pdf")
    for name, doc in [("paper", paper), ("geometry", geometry)]:
        for mode in ["side-by-side", "alternating"]:
            before = snapshot(doc)
            calls = STATE["calls"]
            path, job, work, prepared = preflight(doc, mode)
            assert STATE["calls"] == calls, "preflight unexpectedly called the API"
            assert not prepared["noTextPages"], prepared
            assert any(p["formulas"] for page in prepared["pages"] for p in page["paragraphs"]), "inline formula was not exercised"
            if name == "paper":
                brace_paragraph = next(p for page in prepared["pages"] for p in page["paragraphs"] if "Literal {}" in p["originalSource"])
                for literal in ["{}", "{name}", "{value}", '{"a":{"b":1}}', "open { close } extra {."]:
                    assert literal in brace_paragraph["source"], ("source literal braces changed", literal, brace_paragraph)
            if name == "geometry":
                for page in prepared["pages"]:
                    inline = next(p for p in page["paragraphs"] if "The inline formula" in p["originalSource"])
                    assert re.search(r"The inline formula\s+\{v\d+\}", inline["source"]), ("formula operand was lost from protected crop", page["page"], inline["source"])
            api("POST", path + "/start", {"translateMissing": True, "keepOriginalPages": []}, expected=202)
            job = completed(path)
            assert job["status"] == "ready", job
            data = api("GET", path + "/file")
            assert data.startswith(b"%PDF-")
            output = OUT / f"reader-{name}-{mode}.pdf"
            cancelled_path = OUT / "cancelled-picker.pdf"
            native(doc, job, mode, cancelled_path, cancel=True)
            assert not cancelled_path.exists()
            assert snapshot(doc) == before
            native_result = native(doc, job, mode, output)
            assert output.read_bytes() == data, "native file differs from authenticated GET"
            attached = api("POST", path + "/attachment", {})
            again = api("POST", path + "/attachment", {})
            assert attached["id"] == again["id"] and attached["paperId"] == doc["paperId"]
            papers = api("GET", "/api/papers")
            assert len(papers) == 2, "export created another paper"
            owner = next(p for p in papers if p["id"] == doc["paperId"])
            assert next(a for a in owner["attachments"] if a["documentId"] == attached["id"])["role"] == "translation"
            assert snapshot(doc) == before, "source or reading data changed"
            evidence = OUT / f"{name}-{mode}"
            evidence.mkdir(exist_ok=True)
            for file in ["prepared.json", "targets.json", "layout.json"]:
                shutil.copy2(work / file, evidence / file)
            if name == "paper":
                target = json.loads((work / "targets.json").read_text())[brace_paragraph["id"]]
                for literal in ["{}", "{name}", "{value}", '{"a":{"b":1}}', "打开 { 关闭 } 未闭合 {。"]:
                    assert literal in target, ("completed API target literal braces changed", literal, target)
                results["checks"].append(f"{mode}: literal placeholders, nested JSON and unmatched braces survive real prepare/completed API/native CLI; searchable output checked by inspect.mjs")
            results["exports"].append({"name": name, "mode": mode, "file": str(output), "source": str(OUT / ("reader-synthetic-paper.pdf" if name == "paper" else "reader-geometry.pdf")), "evidence": str(evidence), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "preflight": job["preflight"], "apiCalls": STATE["calls"] - calls, "native": native_result, "attachmentId": attached["id"]})
            (OUT / "result.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
            api("DELETE", path, expected=204)
            assert not work.exists(), "cancel did not remove job files"
            print(name, mode, "ready/native bytes/attachment dedup/preservation PASS", flush=True)

    STATE["mode"] = "overflow"
    path, job, work, _ = preflight(paper, "alternating", fromPage=1, toPage=1)
    api("POST", path + "/start", {"translateMissing": True, "keepOriginalPages": []}, expected=202)
    failed = completed(path)
    assert failed["status"] == "failed", failed
    assert "第 1 页" in failed["error"] and "段" in failed["error"], failed
    api("GET", path + "/file", expected=409)
    assert not (work / "output.pdf").exists()
    results["overflow"] = failed
    api("DELETE", path, expected=204)
    assert snapshot(paper) == baseline

    for action, doc in [("cancel", paper), ("delete", imported("reader-no-text.pdf"))]:
        # A no-text page requires an explicit decision and is never sent to API.
        if action == "delete":
            path, job, work, _ = preflight(doc, "alternating")
            assert job["preflight"]["noTextPages"] == [1]
            api("POST", path + "/start", {"translateMissing": True, "keepOriginalPages": []}, expected=400)
            api("POST", path + "/start", {"translateMissing": True, "keepOriginalPages": [1]}, expected=202)
            assert completed(path)["status"] == "ready"
            api("DELETE", f'/api/documents/{doc["id"]}', expected=204)
            api("GET", path + "/file", expected=(404, 409))
            api("POST", path + "/attachment", {}, expected=(404, 409))
            assert not work.exists()
            results["checks"].append("no-text requires explicit keep; deleted ready source cannot download/attach")
            continue
        STATE["mode"] = "blocked"
        ENTERED.clear(); RELEASE.clear()
        path, job, work, _ = preflight(doc, "alternating", fromPage=1, toPage=1)
        api("POST", path + "/start", {"translateMissing": True, "keepOriginalPages": []}, expected=202)
        assert ENTERED.wait(10), "no real API request to cancel"
        api("DELETE", path, expected=204)
        RELEASE.set()
        api("GET", path + "/file", expected=404)
        api("POST", path + "/attachment", {}, expected=404)
        assert not work.exists()
        assert snapshot(paper) == baseline
        results["checks"].append("cancel in-flight API joins worker, removes files, denies late file/attachment; source/reading rows unchanged")

    # Delete a genuinely running translated source, not merely a ready task.
    doc = geometry
    ENTERED.clear(); RELEASE.clear()
    path, job, work, _ = preflight(doc, "alternating", fromPage=1, toPage=1)
    api("POST", path + "/start", {"translateMissing": True, "keepOriginalPages": []}, expected=202)
    assert ENTERED.wait(10)
    api("DELETE", "/api/documents/" + doc["id"], expected=204)
    RELEASE.set()
    api("GET", path + "/file", expected=(404, 409))
    api("POST", path + "/attachment", {}, expected=(404, 409))
    assert not work.exists()
    assert snapshot(paper) == baseline
    results["checks"].append("delete during API request joins worker; no late ready file/attachment")
    assert not STATE["errors"], STATE["errors"]
    # Final preview must not retain a dead endpoint/test key.
    api("PUT", "/api/ai/config", {"primary": "codex", "api": {"url": "", "key": "", "protocol": "openai"}, "translationModels": {}, "models": {}, "apiModels": []})
    cleared = api("GET", "/api/ai/config")
    assert not cleared["api"]["url"] and not cleared["api"]["hasKey"]
    results["mockCalls"] = STATE["calls"]
    results["passed"] = True
    results["preservation"] = {"sha256": baseline["sha256"], "nonemptyRows": {k: len(v) for k, v in baseline["rows"].items()}, "unchanged": True}
    results["checks"].append("preview API configuration cleared")
    (OUT / "result.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print("Full-stack acceptance PASS:", STATE["calls"], "deterministic mock requests; library", library, flush=True)
finally:
    RELEASE.set()
    server.send_signal(signal.SIGTERM)
    try:
        server.wait(timeout=20)
    except subprocess.TimeoutExpired:
        server.kill(); server.wait()
        raise AssertionError("server did not join on exit")
    log.close()
    mock.shutdown(); mock.server_close()
    print("Diagnostics:", OUT / "server.log", "temporary library:", library, flush=True)
