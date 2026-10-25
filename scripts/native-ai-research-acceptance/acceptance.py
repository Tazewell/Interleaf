"""Owned real-server acceptance. Only model/scientific services are deterministic.

The scholarly proxy is process-scoped, with an owned CA. Production DNS/public-IP
checks, source throttling, TLS verification, parsers, auth and SQLite stay real.
It never forwards a request, changes hosts/trust, or reads another app's secrets.
"""
import hashlib
import base64
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import struct
import zlib

ROOT, OUT = [Path(x).resolve() for x in sys.argv[1:3]]
LIB = OUT / 'library'
KEY = 'owned-deterministic-test-key'
MODELS = {role: 'acceptance-' + role for role in ['chat', 'translation', 'vision', 'research']}
STATE = {'modelCalls': 0, 'searchCalls': {'arxiv': 0, 'crossref': 0}, 'requests': [], 'errors': [], 'mode': 'full', 'block': False, 'cardSources': []}
ENTERED, RELEASE = threading.Event(), threading.Event()
RESULT = {'implementationCommit': os.environ.get('READER_IMPLEMENTATION_COMMIT', ''), 'checks': {}, 'scope': {}, 'artifacts': {}, 'warnings': [], 'scientificQuality': 'unverified: deterministic model, no user model key supplied'}
SERVER = None


def save():
    (OUT / 'result.json').write_text(json.dumps(RESULT, ensure_ascii=False, indent=2))


def check(name, condition, evidence=None):
    assert condition, (name, evidence)
    RESULT['checks'][name] = True
    if evidence is not None:
        RESULT.setdefault('evidence', {})[name] = evidence
    save()
    print('PASS', name, flush=True)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def uid():
    return uuid.uuid4().hex


def wait(fn, timeout=180):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        value = fn()
        if value:
            return value
        time.sleep(.05)
    raise AssertionError('deadline: ' + getattr(fn, '__name__', 'condition'))


def texts(messages):
    return '\n'.join(m.get('content', '') if isinstance(m.get('content'), str) else '\n'.join(p.get('text', '') for p in m.get('content', []) or [] if isinstance(p, dict)) for m in messages)


def vision_probe_answer(messages):
    image = next(p['image_url']['url'] for m in messages for p in (m.get('content') if isinstance(m.get('content'), list) else []) if p.get('type') == 'image_url')
    png = base64.b64decode(image.split(',', 1)[1]); offset, compressed = 8, b''
    while offset < len(png):
        length = struct.unpack('>I', png[offset:offset+4])[0]; kind = png[offset+4:offset+8]; data = png[offset+8:offset+8+length]; offset += length + 12
        if kind == b'IHDR': width, height, depth, color, *_ = struct.unpack('>IIBBBBB', data)
        if kind == b'IDAT': compressed += data
    assert depth == 8 and color in [2, 6] and (width, height) == (800, 140)
    bpp = 3 if color == 2 else 4; stride = width * bpp; raw = zlib.decompress(compressed); prev = bytearray(stride)
    for y in range(71):
        mode = raw[y*(stride+1)]; row = bytearray(raw[y*(stride+1)+1:(y+1)*(stride+1)])
        for i in range(stride):
            a, b, c = row[i-bpp] if i >= bpp else 0, prev[i], prev[i-bpp] if i >= bpp else 0
            p = a+b-c; distances = [abs(p-a), abs(p-b), abs(p-c)]
            predictor = [0, a, b, (a+b)//2, [a,b,c][distances.index(min(distances))]][mode]
            row[i] = (row[i]+predictor) & 255
        prev = row
    colors = {(230,30,30): 'RED', (25,70,235): 'BLUE', (30,175,65): 'GREEN', (245,210,20): 'YELLOW'}
    return ' '.join(colors[tuple(prev[(i*100+50)*bpp:(i*100+50)*bpp+3])] for i in range(8))


def model_answer(text):
    def data(marker):
        return json.loads(text.rsplit(marker + '\n', 1)[1])
    if 'RESEARCH_EVIDENCE_JSON\n' in text:
        ev = data('RESEARCH_EVIDENCE_JSON')
        STATE['cardSources'].append([v['sourceId'] for v in ev])
        fields = {k: {'text': '', 'evidenceIds': []} for k in ['problem', 'method', 'assumptions', 'dataAndEvaluation', 'findings', 'limitations']}
        fields['findings'] = {'text': ' '.join(v['text'] for v in ev), 'evidenceIds': [v['sourceId'] for v in ev]}
        return fields
    if 'RESEARCH_CARDS_JSON\n' in text:
        items = data('RESEARCH_CARDS_JSON')
        ids, lines = [], ['## Controlled synthetic evidence comparison', 'Known conflict must be retained; this is a protocol fixture, not scientific validation.']
        for item in items:
            fact = item['Fact']
            if fact['evidenceIds']:
                ids.extend(fact['evidenceIds'])
                lines.append(item['Title'] + ': ' + fact['text'] + ' ' + ' '.join('[' + x + ']' for x in fact['evidenceIds']))
        return {'content': '\n\n'.join(lines), 'sourceIds': list(dict.fromkeys(ids))}
    if 'RESEARCH_IDEA_EVIDENCE_JSON\n' in text:
        ev = data('RESEARCH_IDEA_EVIDENCE_JSON')[0]
        return {'ideas': [{'id': 'variance-idea', 'problem': 'Sparse graph calibration', 'mechanism': 'Uncertainty weighted graph propagation with variance weights', 'hypotheses': ['Variance weights improve held-out calibration'], 'changes': ['Replace uniform aggregation'], 'nearestWorkIds': [ev.get('candidateId') or ev['paperId']], 'basis': [{'text': ev['excerpt'], 'evidenceIds': [ev['id']]}], 'minimumExperiment': 'Use fixed graph splits and report calibration error', 'baselines': ['Uniform aggregation'], 'ablations': ['Remove variance weighting'], 'falsification': 'No improvement on held-out calibration', 'resources': 'One small synthetic graph; real compute unknown', 'claims': [{'id': 'method-1', 'kind': 'method', 'text': 'Uncertainty weighted graph propagation with variance weights'}]}]}
    if 'RESEARCH_NOVELTY_INPUT_JSON\n' in text:
        v = data('RESEARCH_NOVELTY_INPUT_JSON')
        rows = []
        for claim in v['idea']['claims']:
            row = {'claimId': claim['id'], 'status': 'insufficient', 'relatedWorkIds': [], 'evidenceIds': [], 'overlap': '', 'difference': '', 'unverified': 'Abstracts alone cannot establish a method difference; real experiments remain unverified.'}
            for ev in v['evidence']:
                if ev.get('candidateId') and ev['kind'] in ['remote-html', 'remote-page'] and 'uncertainty weighted' in ev['excerpt']:
                    row.update(status='high_overlap', relatedWorkIds=[ev['candidateId']], evidenceIds=[ev['id']], overlap='B2 already implements uncertainty weighted graph propagation with variance weights')
                    break
            rows.append(row)
        return {'rows': rows}
    if 'RESEARCH_NOVELTY_QUERY\n' in text:
        return {'synonym': 'uncertainty graph propagation', 'mechanism': 'variance weighted aggregation', 'adjacent': 'confidence sensor fusion'}
    if 'RESEARCH_NETWORK_QUERY\n' in text:
        return {'query': 'variance weighted graph propagation'}
    if 'RESEARCH_NETWORK_CANDIDATES_JSON\n' in text:
        return {'candidateIds': [x['id'] for x in data('RESEARCH_NETWORK_CANDIDATES_JSON') if x.get('doi') in ['10.1000/b2', '10.1000/abstract-b2']][:1]}
    if 'READER_TOOL_PROBE' in text or '工具' in text and 'probe' in text:
        return 'Tool unavailable in deterministic fixture'
    if '输入资料：\n' in text and '只输出 JSONL' in text:
        data = json.loads(text.rsplit('输入资料：\n', 1)[1])
        return '\n'.join(json.dumps({'blockId': p['blockId'], 'sourceHash': p['sourceHash'], 'sentences': [{'source': p['source'], 'target': '确定性测试译文：图传播校准结果。'}]}, ensure_ascii=False) for p in data['batch']['paragraphs']) + '\n'
    if 'READER_OK' in text: return 'READER_OK'
    return 'ok'


class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def do_GET(self):
        self.send_response(200); self.end_headers()
        self.wfile.write(json.dumps({'data': [{'id': x} for x in MODELS.values()]}).encode())

    def do_POST(self):
        try:
            req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            assert self.headers.get('Authorization') == 'Bearer ' + KEY
            assert req['model'] in MODELS.values(), req['model']
            text = texts(req['messages'])
            assert 'legacy-private-thread' not in text and 'legacy-private-pi-entry' not in text
            STATE['modelCalls'] += 1
            STATE['requests'].append({'model': req['model'], 'stage': next((x for x in re.findall('RESEARCH_[A-Z_]+', text)), 'other')})
            with open(OUT / 'model-requests.jsonl', 'a') as log:
                log.write(json.dumps({'model': req['model'], 'messages': req['messages']}, ensure_ascii=False) + '\n')
            if STATE['block']:
                ENTERED.set(); RELEASE.wait(30)
            tool_messages = [m for m in req['messages'] if m.get('role') == 'tool']
            names = [t['function']['name'] for t in req.get('tools', [])]
            call = None
            if 'Call reader_probe once' in text:
                if tool_messages: answer = tool_messages[-1]['content']
                else: call = ('reader_probe', {})
            elif 'one horizontal row of 8 colored squares' in text:
                answer = vision_probe_answer(req['messages'])
            elif req['model'] == MODELS['chat'] and 'read_passage' in names:
                if tool_messages:
                    source = json.loads(tool_messages[-1]['content'])['items'][0]
                    answer = 'Original evidence: ' + source['text'] + ' [' + source['sourceId'] + ']'
                else: call = ('read_passage', {'full': True})
            elif req['model'] == MODELS['vision'] and any(p.get('type') == 'image_url' for m in req['messages'] for p in (m.get('content') if isinstance(m.get('content'), list) else [])):
                STATE['imageReceived'] = True; answer = 'The supplied synthetic image contains a blue rectangular bar.'
            else: answer = model_answer(text)
            if call:
                self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
                event = {'choices': [{'index': 0, 'delta': {'tool_calls': [{'index': 0, 'id': uid(), 'type': 'function', 'function': {'name': call[0], 'arguments': json.dumps(call[1])}}]}, 'finish_reason': 'tool_calls'}]}
                self.wfile.write(('data: '+json.dumps(event)+'\n\ndata: [DONE]\n\n').encode()); self.wfile.flush(); return
            content = answer if isinstance(answer, str) else json.dumps(answer, ensure_ascii=False)
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
            for part in [content[:len(content)//2], content[len(content)//2:]]:
                self.wfile.write(('data: ' + json.dumps({'choices': [{'index': 0, 'delta': {'content': part}}]}) + '\n\n').encode())
            self.wfile.write(b'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError): pass
        except Exception as e:
            STATE['errors'].append(repr(e)); self.send_error(500)


class Public(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def do_CONNECT(self):
        # The production client sends a DNS-pinned numeric public address.
        assert re.fullmatch(r'[\d.]+:443|\[[0-9a-f:]+\]:443', self.path), self.path
        self.send_response(200); self.end_headers()
        try:
            wrapped = TLS.wrap_socket(self.connection, server_side=True)
            Public(wrapped, self.client_address, self.server)
        except (ssl.SSLError, ConnectionResetError, BrokenPipeError): pass
        self.close_connection = True

    def do_GET(self):
        assert not self.headers.get('Authorization'), 'model credential sent to scholarly service'
        host = self.headers.get('Host', '').split(':')[0]
        url = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(url.query)
        status, kind, body = 200, 'text/html', b''
        if host == 'export.arxiv.org':
            STATE['searchCalls']['arxiv'] += 1
            start = int(q.get('start', ['0'])[0])
            entries = ''
            # Offer a second page. The task pipeline bounds each novelty query
            # to its first page; scholar cursor traversal has separate tests.
            for i in range(start, min(start + 5, 6)):
                doi = ('10.1000/abstract-b2' if STATE['mode'] == 'abstract' else '10.1000/b2') if i == 0 else f'10.1000/arxiv-{i}'
                entries += f'<entry><id>http://arxiv.org/abs/2610.{(20000 if STATE['mode'] == 'abstract' else 10000)+i}v1</id><title>Shared graph title</title><summary>Only an abstract of graph propagation.</summary><published>2026-10-01T00:00:00Z</published><updated>2026-10-01T00:00:00Z</updated><author><name>Fixture Author</name></author><arxiv:doi>{doi}</arxiv:doi><link href="https://1.1.1.1/full" rel="alternate" type="text/html"/></entry>'
            body = f'<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>6</opensearch:totalResults><opensearch:startIndex>{start}</opensearch:startIndex><opensearch:itemsPerPage>5</opensearch:itemsPerPage>{entries}</feed>'.encode(); kind = 'application/atom+xml'
        elif host == 'api.crossref.org':
            STATE['searchCalls']['crossref'] += 1
            cursor = q.get('cursor', ['*'])[0]
            items = [{'DOI': '10.1000/abstract-b2' if STATE['mode'] == 'abstract' else '10.1000/b2', 'title': ['B2: Variance weighting in graph propagation'], 'abstract': 'Only an abstract; full text is required.', 'URL': 'https://1.1.1.1/full', 'link': [{'URL': 'https://1.1.1.1/B2.pdf', 'content-type': 'application/pdf'}], 'published': {'date-parts': [[2026, 9, 1]]}}] if cursor == '*' else []
            body = json.dumps({'status': 'ok', 'message-type': 'work-list', 'message': {'items-per-page': 5, 'total-results': 1, 'next-cursor': 'owned-next', 'items': items}}).encode(); kind = 'application/json'
        elif host in ['1.1.1.1', 'arxiv.org']:
            if STATE['mode'] == 'abstract': status, body = 404, b'Owned full text unavailable'
            elif url.path.endswith('.pdf') or '/pdf/' in url.path: kind, body = 'application/pdf', (OUT / 'fixtures/B2.pdf').read_bytes()
            else: body = b'<html><body><h1>B2: Variance weighting</h1><p>We implement uncertainty weighted graph propagation with variance weights. Fixed graph splits compare uniform and variance weighted aggregation.</p></body></html>'
        else:
            STATE['errors'].append('unexpected scholarly host ' + host); status, body = 502, b'Unexpected host'
        if STATE['mode'] == 'throttle' and host == 'export.arxiv.org': status, body = 429, b'Owned rate limit'
        with open(OUT / 'public-requests.jsonl', 'a') as log:
            log.write(json.dumps({'host': host, 'path': self.path, 'status': status, 'monotonic': time.monotonic(), 'authorization': False}) + '\n')
        self.send_response(status); self.send_header('Content-Type', kind); self.send_header('Content-Length', str(len(body))); self.end_headers()
        try: self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError): pass


def api(method, path, body=None, expected=200, content_type='application/json'):
    if body is not None and not isinstance(body, bytes): body = json.dumps(body).encode()
    req = urllib.request.Request(DISC['url'] + path, data=body, method=method, headers={'Authorization': 'Bearer ' + DISC['token'], 'Content-Type': content_type})
    try: response = urllib.request.urlopen(req, timeout=180)
    except urllib.error.HTTPError as e: response = e
    with response:
        raw = response.read()
        assert response.status in (expected if isinstance(expected, tuple) else (expected,)), (method, path, response.status, raw[:1200])
        return json.loads(raw) if raw and response.headers.get_content_type() == 'application/json' else raw


def start():
    global SERVER, DISC
    SERVER = subprocess.Popen([str(ROOT / 'apps/desktop/bin/reader-server'), '--data', str(LIB), '--port', '0', '--connector=false', '--web', str(ROOT / 'apps/web/dist'), '--shutdown-on-stdin'], cwd=OUT, env=ENV, stdin=subprocess.PIPE, stdout=open(OUT / 'server-private.log', 'ab'), stderr=subprocess.STDOUT)
    def discover():
        assert SERVER.poll() is None, 'server exited; inspect owned server-private.log'
        p = LIB / 'server.json'
        if p.exists():
            value = json.loads(p.read_text())
            if value['pid'] == SERVER.pid: return value
    DISC = wait(discover)


def stop():
    if SERVER is not None and SERVER.poll() is None:
        SERVER.stdin.close(); SERVER.wait(timeout=35)
        assert SERVER.returncode == 0, SERVER.returncode


def blocked_run(tid, sid):
    ENTERED.clear(); RELEASE.clear(); STATE['block'] = True
    run = create(tid, sid, 'overview')
    control(run, 'start')
    assert ENTERED.wait(30), 'real model request never reached lifecycle barrier'
    return run


def unblock():
    STATE['block'] = False; RELEASE.set()


def imported(name):
    boundary = 'OwnedTask11Boundary'
    library = 'books' if name.endswith('.epub') else 'papers'
    content = (f'--{boundary}\r\nContent-Disposition: form-data; name="library"\r\n\r\n{library}\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n').encode() + (OUT / 'fixtures' / name).read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
    doc = api('POST', '/api/documents', content, 201, 'multipart/form-data; boundary=' + boundary)
    if name.endswith('.pdf'):
        manifest = LIB / 'cache' / doc['id'] / 'analysis/manifest.json'
        def ready():
            p = api('GET', '/api/documents/' + doc['id'] + '/assistance')
            assert p.get('status') != 'failed', p
            return manifest.exists() and p.get('phase') != 'learning'
        wait(ready)
        m = json.loads(manifest.read_text()); assert m['inputSHA256'] == sha(OUT / 'fixtures' / name)
        RESULT.setdefault('processor', {})[name] = {'pages': m['pages'], 'blocks': len(m['blocks']), 'inputSHA256': m['inputSHA256']}
    return doc


def paper(title, folder, abstract=''):
    return api('POST', '/api/papers', {'title': title, 'folders': [folder], 'metadata': {'abstract': abstract}}, 201)


def topic(folder):
    return api('POST', '/api/research/topics', {'title': folder + ' research', 'folder': folder}, 201)['id']


def session(tid):
    return api('POST', '/api/research/topics/' + tid + '/sessions', {'title': 'Owned acceptance'}, 201)['id']


def create(tid, sid, mode='compare', network='deny', maximum=200, **extra):
    body = {'userMessageId': uid(), 'question': 'Compare graph evidence and retain conflict; assess variance weighting', 'mode': mode, 'network': network, 'budget': {'maxModelRequests': maximum, 'maxSearchRequests': 100, 'maxRemoteReads': 50, 'maxMinutes': 30}, **extra}
    return api('POST', f'/api/research/topics/{tid}/sessions/{sid}/runs', body, 201)


def control(run, action, **extra):
    return api('POST', '/api/research/runs/' + run['id'] + '/' + action, {'requestId': uid(), **extra}, (200, 202))


def terminal(run, status='completed'):
    def done():
        v = api('GET', '/api/research/runs/' + run['id'])
        assert v['status'] not in ['failed', 'interrupted', 'canceled'] or v['status'] == status, v
        return v if v['status'] == status else None
    return wait(done)


def snapshot(run):
    with sqlite3.connect(LIB / 'reader.sqlite') as db:
        return json.loads(db.execute('SELECT body FROM research_snapshots WHERE id=?', (run['snapshotId'],)).fetchone()[0])


def preservation(doc):
    with sqlite3.connect(LIB / 'reader.sqlite') as db:
        rows = {t: db.execute(f'SELECT * FROM {t} WHERE document_id=? ORDER BY rowid', (doc['id'],)).fetchall() for t in ['messages', 'annotations', 'document_notes', 'translations', 'translation_previous', 'document_conversations']}
        key = db.execute('SELECT citation_key FROM paper_items WHERE id=?', (doc['paperId'],)).fetchone()[0]
    return {'rows': rows, 'citationKey': key, 'originalSHA256': sha(LIB / 'papers' / (doc['id'] + '.pdf'))}


assert ROOT not in OUT.parents and ROOT != OUT
assert re.fullmatch('[a-f0-9]{40}', RESULT['implementationCommit']), 'set READER_IMPLEMENTATION_COMMIT to actual source HEAD'
RESULT['implementationState'] = 'Product HEAD; acceptance harness bytes recorded independently (may be uncommitted at execution)'
RESULT['acceptanceSourceHashes'] = {str(p.relative_to(ROOT)): sha(p) for p in (ROOT / 'scripts/native-ai-research-acceptance').iterdir() if p.is_file()}
RESULT['builtServerSHA256'] = sha(ROOT / 'apps/desktop/bin/reader-server')
assert not LIB.exists(), 'use a new output directory; never overwrite an existing acceptance library'
LIB.mkdir()
legacy = {'version': 1, 'config': {'primary': 'codex', 'models': {'codex': 'legacy'}, 'translationPrompt': 'Keep my translation prompt'}}
(LIB / 'ai-connections.json').write_text(json.dumps(legacy))
tlsdir = OUT / 'tls'; tlsdir.mkdir()
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(tlsdir / 'key.pem'), '-out', str(tlsdir / 'cert.pem'), '-days', '2', '-subj', '/CN=Reader owned acceptance', '-addext', 'subjectAltName=DNS:export.arxiv.org,DNS:api.crossref.org,DNS:arxiv.org,IP:1.1.1.1'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
TLS = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); TLS.load_cert_chain(tlsdir / 'cert.pem', tlsdir / 'key.pem')
model = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Model)
proxy = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Public)
for server in [model, proxy]: threading.Thread(target=server.serve_forever, daemon=True).start()
trap = OUT / 'trap'; trap.mkdir()
for name in ['codex', 'claude', 'kimi', 'pi']:
    p = trap / name; p.write_text('#!/bin/sh\nprintf "%s\\n" "$0" >> "' + str(OUT / 'external-agent-calls.log') + '"\nexit 97\n'); p.chmod(0o700)
ENV = {k: v for k, v in os.environ.items() if not k.startswith('READER_') and k.lower() not in ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']}
ENV.update(PATH=str(trap) + ':' + os.environ['PATH'], READER_NODE=shutil.which('node'), READER_PROCESSOR=str(ROOT / 'apps/processor/dist/main.mjs'), SSL_CERT_FILE=str(tlsdir / 'cert.pem'), HTTP_PROXY=f'http://127.0.0.1:{proxy.server_port}', HTTPS_PROXY=f'http://127.0.0.1:{proxy.server_port}', NO_PROXY='127.0.0.1,localhost')
save()
try:
    start()
    migrated = api('GET', '/api/ai/config')
    check('migration', migrated['version'] == 2 and migrated.get('needsConfiguration') and json.loads((LIB / 'ai-connections.json.v1.bak').read_text()) == legacy)
    api('PUT', '/api/settings', {'autoTranslateMaxPages': 0, 'autoGenerateOverview': False})
    cfg = {'version': 2, 'connection': {'url': f'http://127.0.0.1:{model.server_port}', 'protocol': 'openai', 'key': KEY}, 'models': MODELS, 'apiModels': list(MODELS.values())}
    public = api('PUT', '/api/ai/config', cfg)
    assert public['connection']['hasKey'] and KEY not in json.dumps(public)
    docs = {name: imported(name + '.pdf') for name in ['A', 'B', 'C', 'translated']}
    docs['D'] = imported('D.epub')
    epub_paper = paper('D: Graph assumptions', 'Graph/Sub')
    api('PUT', f'/api/papers/{epub_paper["id"]}/attachments/{docs["D"]["id"]}', {'role': 'original', 'primary': True}, 200)
    docs['D']['paperId'] = epub_paper['id']
    for name in ['A', 'B', 'C', 'D']:
        doc = docs[name]
        api('PATCH', '/api/papers/' + doc['paperId'], {'title': name + ': graph evidence', 'folders': ['Graph/Sub' if name == 'D' else 'Graph'], 'citationKey': 'Acceptance' + name})
    # Detach the translation's original owner before attaching it to A.
    tr = docs['translated']
    api('DELETE', f'/api/papers/{tr["paperId"]}/attachments/{tr["id"]}', expected=200)
    api('PUT', f'/api/papers/{docs["A"]["paperId"]}/attachments/{tr["id"]}', {'role': 'translation'}, 200)
    paper('E: metadata only', 'Graph')
    trash = paper('Recycled paper', 'Graph'); api('POST', '/api/papers/' + trash['id'] + '/trash', {}, 200)
    paper('Outside scope', 'Other')
    doc = docs['A']; stamp = '2026-10-22T00:00:00Z'
    with sqlite3.connect(LIB / 'reader.sqlite') as db:
        message = {'id': uid(), 'documentId': doc['id'], 'role': 'assistant', 'content': 'Historical answer remains byte-identical', 'createdAt': stamp}
        db.execute('INSERT INTO messages VALUES(?,?,?,?)', (message['id'], doc['id'], json.dumps(message), stamp))
        annotation = {'id': uid(), 'documentId': doc['id'], 'kind': 'note', 'note': 'Existing note', 'location': {'type': 'pdf', 'page': 1}, 'quote': 'uniform', 'color': '#facc15', 'createdAt': stamp, 'tags': []}
        db.execute('INSERT INTO document_notes VALUES(?,?,?)', (doc['id'], 'Existing private literature note', stamp))
        db.execute('INSERT INTO translations(document_id,block_id,source_hash,status,body) VALUES(?,?,?,?,?)', (doc['id'], 'historical-reading', 'historical-source', 'complete', json.dumps({'blockId': 'historical-reading', 'status': 'complete', 'sentences': [{'source': 'Existing text', 'target': '已有译文'}]})))
        db.execute('INSERT INTO document_conversations VALUES(?,?,?)', (doc['id'], 'codex', json.dumps({'threadId': 'legacy-private-thread', 'piEntries': ['legacy-private-pi-entry']})))
    # Create through the real API, using the app's canonical stored encoding.
    # Startup anchor capture legitimately reserializes old annotation JSON;
    # Python whitespace/empty optional tags are not an app-produced byte fixture.
    api('POST', '/api/documents/' + doc['id'] + '/annotations', annotation, (200, 201))
    before = preservation(doc)
    # Explicit capability probes through the authenticated public API, without
    # modifying internal capability files. All probe calls are counted.
    for role in ['chat', 'vision']:
        cap = api('POST', '/api/ai/check', {'role': role, 'model': MODELS[role], 'waitSeconds': 30})
        assert cap['text'] and (role != 'vision' or cap['vision']), cap
    b = docs['B']
    chat = api('POST', '/api/documents/' + b['id'] + '/chat', {'provider': 'api', 'prompt': 'Read the original passage and cite its calibration result', 'context': '', 'userMessageId': uid()})
    messages = api('GET', '/api/documents/' + b['id'] + '/messages')
    check('chat', b'event: done' in chat and b'event: fallback' not in chat and any(m.get('role') == 'assistant' and '[S' in m.get('content', '') and m.get('references') for m in messages), messages)
    layout = json.loads((LIB / 'cache' / b['id'] / 'analysis/manifest.json').read_text())
    block = next(x for x in layout['blocks'] if x.get('image'))
    image_chat = api('POST', '/api/documents/' + b['id'] + '/chat', {'provider': 'api', 'prompt': 'Explain this supplied image', 'context': '', 'attachments': [block['id']], 'userMessageId': uid()})
    check('image', b'event: done' in image_chat and STATE.get('imageReceived') is True)
    c = docs['C']
    api('POST', '/api/documents/' + c['id'] + '/translations/range', {'fromPage': 1, 'toPage': 1}, (200, 202))
    def translated():
        rows = api('GET', '/api/documents/' + c['id'] + '/translations')
        assert not any(x['status'] == 'failed' for x in rows), rows
        return rows if rows and all(x['status'] == 'complete' for x in rows) else None
    translation_rows = wait(translated)
    check('translation', any(x.get('sentences') for x in translation_rows), translation_rows)
    tid, sid = topic('Graph'), None
    sid = session(tid)
    run = create(tid, sid, maximum=2)
    scope = snapshot(run); RESULT['scope']['default'] = scope; RESULT['defaultScope'] = len(scope['members'])
    assert RESULT['defaultScope'] == 5, scope
    assert next(m for m in scope['members'] if m['paperId'] == doc['paperId'])['documentId'] == doc['id']
    control(run, 'start'); paused = terminal(run, 'paused')
    # A metadata-only member can complete without inference; model discovery
    # capability calls are recorded separately from the two extraction units.
    initial_sources = list(STATE['cardSources'])
    assert len(initial_sources) == 2 and paused['usage']['attemptRequests'] == 2 and paused['coverage']['readUnits'] == 2, paused
    control(run, 'resume', budget={'maxModelRequests': 200, 'maxSearchRequests': 100, 'maxRemoteReads': 50, 'maxMinutes': 30})
    done = terminal(run); check('pauseResume', done['coverage']['analyzedPapers'] == 5 and len(STATE['cardSources']) == 4 and all(STATE['cardSources'].count(x) == 1 for x in initial_sources), done['coverage'])
    report = api('GET', '/api/research/reports/' + done['latestReportId'])
    check('compare', 'improves' in report['content'] and 'worsens' in report['content'] and len(report['sourceIds']) >= 3)
    for source in report['sourceIds']: assert api('GET', '/api/research/sources/' + source)['availability'] == 'valid'
    api('PATCH', '/api/research/topics/' + tid, {'includeChildren': False})
    direct = create(tid, sid, 'overview'); RESULT['directScope'] = len(snapshot(direct)['members']); assert RESULT['directScope'] == 4
    control(direct, 'start'); overview = terminal(direct); check('overview', bool(overview.get('latestReportId')))
    api('PATCH', '/api/research/topics/' + tid, {'includeChildren': True})
    edit = api('POST', '/api/research/reports/' + report['id'] + '/revisions', {'requestId': uid(), 'content': report['content'] + '\n\nUser note: conflict remains unresolved.'}, 201)
    raw = api('GET', '/api/research/reports/' + edit['id'] + '/markdown')
    (OUT / 'research-report.md').write_bytes(raw)
    check('revisionExport', edit['origin'] == 'user' and edit['id'] != report['id'] and b'conflict' in raw and api('GET', '/api/research/reports/' + report['id'])['content'] == report['content'])
    # Forty actual abstract-backed paper cards, rather than forty metadata placeholders.
    for i in range(40): paper(f'Batch {i:02}: graph evidence', 'Forty', f'Paper {i:02} measures graph calibration with fixed split {i:02}.')
    forty = topic('Forty'); batch = create(forty, session(forty), 'overview')
    control(batch, 'start'); all_done = terminal(batch)
    with sqlite3.connect(LIB / 'reader.sqlite') as db:
        RESULT['fullCoverage'] = db.execute('SELECT count(DISTINCT paper_id) FROM research_cards WHERE paper_id IN (SELECT id FROM paper_items WHERE folders=?) AND json_extract(body,\'$.readCoverage.readUnits\')>0', ('["Forty"]',)).fetchone()[0]
    check('fullCoverage', RESULT['fullCoverage'] == 40 and all_done['coverage']['pendingPapers'] == 0, all_done['coverage'])
    paper_count = len(api('GET', '/api/papers'))
    online = create(tid, sid, 'ideas', 'allow-task', ideaCount=1)
    control(online, 'start'); online_done = terminal(online)
    results = api('GET', '/api/research/runs/' + online['id'] + '/results')
    check('noveltyOverlap', results['novelty'][0]['rows'][0]['status'] == 'high_overlap', results)
    assert len(api('GET', '/api/papers')) == paper_count, 'search auto imported papers'
    candidates = api('GET', '/api/research/topics/' + tid + '/candidates')
    candidate = next(c for c in candidates if c.get('doi') == '10.1000/b2')
    path = f'/api/research/topics/{tid}/candidates/{candidate["id"]}/import'
    request = {'requestId': uid()}; imported_candidate = api('POST', path, request, (200, 201)); again = api('POST', path, request, (200, 201))
    check('candidateImport', imported_candidate['id'] == again['id'] and len(api('GET', '/api/papers')) == paper_count + 1)
    # Distinct identity and topic: an explicitly imported candidate correctly prefers local full text globally.
    STATE['mode'] = 'abstract'
    abstract_topic = topic('Graph/Sub'); abstract_run = create(abstract_topic, session(abstract_topic), 'ideas', 'allow-task', ideaCount=1)
    control(abstract_run, 'start'); terminal(abstract_run)
    insufficient = api('GET', '/api/research/runs/' + abstract_run['id'] + '/results')
    check('noveltyInsufficient', insufficient['novelty'][0]['rows'][0]['status'] == 'insufficient', insufficient)
    STATE['mode'] = 'full'
    novelty_text = '# 实际查新结果（确定性协议夹具）\n\n' + '\n\n'.join(json.dumps(x, ensure_ascii=False, indent=2) for x in [results, insufficient])
    (OUT / 'novelty-report.md').write_text(novelty_text)
    after = preservation(doc); RESULT['preservation'] = {'before': before, 'after': after}; check('preservation', before == after)
    # Scope metadata change invalidates the pending run, while preserving reports.
    stale = create(tid, sid)
    api('PATCH', '/api/papers/' + docs['B']['paperId'], {'title': 'B: source title changed'})
    rejected = api('POST', '/api/research/runs/' + stale['id'] + '/start', {'requestId': uid()}, (200, 202, 409))
    if isinstance(rejected, dict) and rejected.get('id'):
        wait(lambda: api('GET', '/api/research/runs/' + stale['id'])['status'] in ['failed', 'interrupted'])
    check('sourceChange', api('GET', '/api/research/reports/' + report['id'])['content'] == report['content'])
    interrupted = blocked_run(forty, session(forty))
    stop(); unblock(); start()
    check('restart', api('GET', '/api/research/runs/' + interrupted['id'])['status'] == 'interrupted' and api('GET', '/api/research/reports/' + edit['id'])['content'] == edit['content'] and preservation(doc) == before)
    RESULT['modelCalls'] = STATE['modelCalls']; RESULT['searchCalls'] = STATE['searchCalls']; RESULT['modelRequests'] = STATE['requests']
    RESULT['externalAgentCalls'] = len((OUT / 'external-agent-calls.log').read_text().splitlines()) if (OUT / 'external-agent-calls.log').exists() else 0
    assert not STATE['errors'], STATE['errors']
    interrupted_move = blocked_run(forty, session(forty))
    stop(); unblock(); check('close', SERVER.returncode == 0)
    destination = OUT / 'migrated-library'
    subprocess.run([str(ROOT / 'apps/desktop/bin/reader-server'), '--data', str(LIB), '--migrate-library', str(destination)], check=True, env=ENV, stdout=subprocess.DEVNULL)
    old_lib = LIB; LIB = destination
    start(); check('move', preservation(doc) == before and api('GET', '/api/research/runs/' + interrupted_move['id'])['status'] == 'interrupted' and api('GET', '/api/research/reports/' + edit['id'])['content'] == edit['content'])
    active_delete = blocked_run(tid, sid)
    api('DELETE', '/api/documents/' + docs['C']['id'], expected=204)
    unblock()
    check('delete', api('GET', '/api/research/runs/' + active_delete['id'])['status'] == 'interrupted' and preservation(doc) == before and api('GET', '/api/research/reports/' + report['id'])['content'] == report['content'])
    STATE['mode'] = 'throttle'
    limited = create(forty, session(forty), 'overview', 'allow-task')
    control(limited, 'start'); terminal(limited)
    with sqlite3.connect(LIB / 'reader.sqlite') as db:
        audits = [json.loads(x[0]) for x in db.execute('SELECT body FROM research_searches WHERE run_id=?', (limited['id'],))]
    check('rateLimit', any(x.get('status') == 'limited' for x in audits), audits)
    STATE['mode'] = 'full'
    cfg['connection']['key'] = None; api('PUT', '/api/ai/config', cfg)
    check('testKeyCleared', not api('GET', '/api/ai/config')['connection']['hasKey'])
    RESULT['library'] = str(LIB); RESULT['artifacts']['research-report.md'] = sha(OUT / 'research-report.md')
    # The copy source is also owned output and must not retain the sample key.
    stop(); LIB = old_lib; start(); api('PUT', '/api/ai/config', cfg)
    assert not api('GET', '/api/ai/config')['connection']['hasKey']
    stop(); LIB = destination
finally:
    RELEASE.set(); stop(); model.shutdown(); proxy.shutdown(); RESULT['errors'] = STATE['errors']
    RESULT['modelCalls'] = STATE['modelCalls']; RESULT['searchCalls'] = STATE['searchCalls']; RESULT['modelRequests'] = STATE['requests']; save()
