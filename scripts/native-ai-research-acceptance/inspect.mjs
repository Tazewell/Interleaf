import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const out = process.argv[2];
const resultPath = join(out, 'result.json');
assert.ok(existsSync(resultPath), 'missing actual authenticated built-server acceptance result');
const r = JSON.parse(readFileSync(resultPath, 'utf8'));
assert.match(r.implementationCommit, /^[a-f0-9]{40}$/);
assert.equal(r.defaultScope, 5);
assert.equal(r.directScope, 4);
assert.equal(r.fullCoverage, 40);
const trapFile = join(out, 'external-agent-calls.log');
const trapText = existsSync(trapFile) ? readFileSync(trapFile, 'utf8') : '';
// Match Python str.splitlines(), including an unterminated final record.
const lines = trapText.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/);
const trailingBreak = /[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]$/.test(trapText);
const trapCount = trapText ? lines.length - Number(trailingBreak) : 0;
assert.equal(r.externalAgentCalls, trapCount, 'external Agent trap count differs from actual file');
assert.equal(r.externalAgentCalls, 0);
assert.ok(r.modelCalls > 0);
assert.ok(r.searchCalls.arxiv > 0 && r.searchCalls.crossref > 0);
assert.deepEqual(r.preservation.before, r.preservation.after);
assert.ok(r.preservation.before.rows.annotations.length);
for (const name of ['migration', 'chat', 'image', 'translation', 'overview', 'compare', 'pauseResume', 'sourceChange', 'noveltyOverlap', 'noveltyInsufficient', 'candidateImport', 'revisionExport', 'restart', 'close', 'move', 'delete', 'rateLimit', 'testKeyCleared']) {
  assert.equal(r.checks[name], true, `${name}: missing real behavior evidence`);
}
for (const name of ['research-report.md', 'research-report.pdf']) {
  assert.ok(existsSync(join(out, name)), `missing real output ${name}`);
  assert.equal(createHash('sha256').update(readFileSync(join(out,name))).digest('hex'),r.artifacts[name]);
}
assert.equal(JSON.parse(readFileSync(join(out,'count-join/result.json'),'utf8')).passed,true);
const pdfText=execFileSync('pdftotext',[join(out,'research-report.pdf'),'-'],{encoding:'utf8'});
for(const word of ['improves','worsens','conflict']) assert.ok(pdfText.includes(word),word);
const novelty=readFileSync(join(out,'novelty-report.md'),'utf8');
assert.ok(novelty.includes('high_overlap') && novelty.includes('insufficient'));
assert.ok(pdfText.includes('high_overlap') && pdfText.includes('insufficient'));
assert.deepEqual(r.errors,[]);
assert.match(readFileSync(join(out, 'research-report.md'), 'utf8'), /conflict|冲突/);
console.log('Native AI real-server acceptance checks PASS');
