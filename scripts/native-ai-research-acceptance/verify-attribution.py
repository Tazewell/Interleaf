"""Inspect actual focused HTTP evidence and historical ONNX sample attribution.

The second input is read-only historical evidence, not a fresh source GET or
permission to revive stale/removed sources. No model or processor is rerun.
"""
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys

from attribution import assert_attribution, assert_claim_bindings

out, prior = [Path(x).resolve() for x in sys.argv[1:3]]
data = json.loads((out / 'attribution-http.json').read_text())
assert_attribution(data['report'], data['sources'], data['expected'])
assert len(data['sources']) == 2 and data['modelCalls'] == 3
assert {x['location']['blockId'] for x in data['sources'].values()} == {'p1-b1'}
for item in data['expected']:
    raw = (out / (item['documentId'] + '-controlled-original.txt')).read_bytes()
    assert raw.decode() == item['claim']
    assert hashlib.sha256(raw).hexdigest() == item['originalSHA256']

# Mutate only a copy of the actual HTTP report, keeping both real valid source
# records untouched. The negative is a verifier test, not a product failure.
negative = copy.deepcopy(data['report'])
a, b = negative['sourceIds']
negative['content'] = negative['content'].replace('['+a+']', '[SWAP]').replace('['+b+']', '['+a+']').replace('[SWAP]', '['+b+']')
try:
    assert_attribution(negative, data['sources'], data['expected'])
except AssertionError as err:
    swapped_rejection = str(err)
else:
    raise AssertionError('actual swapped-but-valid source attribution escaped verification')

previous = json.loads((prior / 'result.json').read_text())
with sqlite3.connect('file:' + previous['library'] + '/reader.sqlite?mode=ro', uri=True) as db:
    reports = [json.loads(x[0]) for x in db.execute('SELECT body FROM research_reports')]
    report = next(x for x in reports if x['origin'] == 'model' and 'improves' in x['content'] and 'worsens' in x['content'])
    sources = {sid: json.loads(db.execute('SELECT body FROM research_evidence WHERE id=?', (sid,)).fetchone()[0]) for sid in report['sourceIds']}
    expected = []
    for name, claim in [('A', 'Uniform aggregation improves calibration on sparse graphs.'), ('B', 'Uniform aggregation worsens calibration on sparse graphs.')]:
        # Bind IDs independently to the original scope metadata, not the claim's citation.
        member = next(x for x in previous['scope']['default']['members'] if x['title'].startswith(name+':'))
        expected.append({'paperId': member['paperId'], 'documentId': member['documentId'], 'claim': claim})
        pdf = prior / 'fixtures' / (name + '.pdf')
        assert hashlib.sha256(pdf.read_bytes()).hexdigest() == member['sourceHash']
        assert claim in subprocess.check_output(['pdftotext', str(pdf), '-'], text=True)
    assert_claim_bindings(report, sources, expected)

result = {'seededHTTP': True, 'sameBareBlock': 'p1-b1', 'modelCalls': data['modelCalls'],
          'swappedValidSourceRejected': swapped_rejection,
          'historicalONNX': {'reportId': report['id'], 'expected': expected,
                             'sourceAvailability': {sid: ev['availability'] for sid, ev in sources.items()},
                             'boundary': 'stored claim binding + original PDF text/hash only; stale/removed statuses unchanged; no new HTTP source validation'},
          'inputSHA256': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [out / 'attribution-http.json', prior / 'result.json']}}
(out / 'attribution-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
print('PASS actual seeded HTTP attribution, swapped-valid negative, and historical ONNX claim/original binding')
