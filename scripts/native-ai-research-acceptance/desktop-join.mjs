// Execute the real desktop stop/copy helpers against an instrumented Go test
// server. Production cmdmain/Electron lifecycle is checked separately.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [out, binary] = process.argv.slice(2);
const dir = join(out, 'count-join');
mkdirSync(dir); mkdirSync(join(dir, 'profile'));
const { stopLibraryServer, migrateLibrary, libraryDirectory } = await import(pathToFileURL(join(out, 'library-location.mjs')));
const child = spawn(join(out, 'interleaf-tests'), ['-test.run=^TestResearchImportDesktopHelper$', '-test.timeout=45s'], {
  env: { ...process.env, INTERLEAF_TEST_COUNT_JOIN_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'],
});
let logs = ''; child.stdout.on('data', x => logs += x); child.stderr.on('data', x => logs += x);
const wait = async fn => { const until = Date.now()+25000; while(Date.now()<until) { if(fn()) return; assert.equal(child.exitCode, null, logs); await new Promise(r=>setTimeout(r,20)); } throw Error('barrier deadline '+logs); };
try {
  await wait(()=>existsSync(join(dir,'ready.json')));
  const ready = JSON.parse(readFileSync(join(dir,'ready.json')));
  const source = join(dir,'library'), dest = join(dir,'migrated');
  const snapshot = root => JSON.parse(execFileSync('python3', ['-c', `import json,sqlite3,hashlib,sys,pathlib
p=pathlib.Path(sys.argv[1]); c=sqlite3.connect(p/'interleaf.sqlite')
print(json.dumps({'documents':c.execute('select id,title from documents order by id').fetchall(),'notes':c.execute('select * from document_notes order by document_id').fetchall(),'keys':c.execute('select citation_key from paper_items order by id').fetchall(),'imports':c.execute("select count(*) from research_units where kind='candidate-import'").fetchone()[0],'originals':{x.name:hashlib.sha256(x.read_bytes()).hexdigest() for x in (p/'papers').glob('*.pdf')}}))`, root], {encoding:'utf8'}));
  const before = snapshot(source); assert.equal(before.notes.length,1); assert.equal(before.documents.length,1); assert.ok(before.keys.flat().includes('CountJoin2026'));
  const request = fetch(ready.url+ready.path, {method:'POST', headers:{Authorization:'Bearer '+ready.token,'Content-Type':'application/json'}, body:JSON.stringify({requestId:'0123456789abcdef0123456789abcdef'})}).then(async r=>({status:r.status,body:await r.text()}));
  await wait(()=>existsSync(join(dir,'count-entered')));
  const migration = migrateLibrary(join(dir,'profile'),source,dest,binary,()=>stopLibraryServer(child));
  await wait(()=>existsSync(join(dir,'shutdown-requested')));
  await new Promise(r=>setTimeout(r,250));
  assert.equal(child.exitCode,null); assert.equal(existsSync(dest),false); assert.equal(existsSync(join(dir,'profile/library-location.json')),false);
  assert.deepEqual(snapshot(source),before);
  writeFileSync(join(dir,'release-count'),'release real ReaderAt');
  await migration;
  const response = await request; assert.notEqual(response.status,200); assert.notEqual(response.status,201);
  assert.equal(child.exitCode,0); assert.equal(await libraryDirectory(join(dir,'profile')),dest);
  assert.deepEqual(snapshot(dest),before); assert.deepEqual(snapshot(source),before);
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'joined.json'))),{imports:0,documents:1});
  writeFileSync(join(dir,'result.json'),JSON.stringify({passed:true,boundary:'instrumented Go test Server + real candidate HTTP + real PDF ReaderAt + actual desktop helpers + production Go CopyLibrary',responseStatus:response.status,before,after:snapshot(dest)},null,2));
  console.log('PASS synchronous PDF count / candidate import / desktop migration join');
} finally {
  writeFileSync(join(dir,'release-count'),'cleanup release');
  if(child.exitCode===null) await stopLibraryServer(child);
  writeFileSync(join(dir,'helper.log'),logs);
}
