// Render actual exported Markdown and audited novelty evidence as a readable
// inspection artifact. This is not an additional application export feature.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const require=createRequire(new URL('../../apps/processor/package.json',import.meta.url));
const {PDFDocument,rgb}=require('pdf-lib'); const fontkit=require('@pdf-lib/fontkit');
const out=process.argv[2], root=new URL('../../',import.meta.url);
const pdf=await PDFDocument.create();
const fontBytes=readFileSync(new URL('apps/processor/dist/fonts/NotoSansSC.ttf',root));
// Match the production PDF worker: the bundled face is variable, and direct
// subsetting leaves many outlines blank. Instantiate regular weight first.
const regular=fontkit.create(new Uint8Array(fontBytes)).getVariation({wght:400});
pdf.registerFontkit({create:()=>regular});
const font=await pdf.embedFont(fontBytes,{subset:true});
pdf.setTitle('Reader actual research acceptance report'); pdf.setAuthor('Reader controlled acceptance');
const r=JSON.parse(readFileSync(join(out,'result.json'),'utf8'));
const summaries = ['noveltyOverlap','noveltyInsufficient'].flatMap(key=>r.evidence[key].novelty.flatMap(n=>n.rows.map(row=>`${key}: ${row.status}\n${row.overlap || row.unverified}\nSources: ${row.evidenceIds.join(', ')}`)));
const markdown=readFileSync(join(out,'research-report.md'),'utf8')+'\n\n## Actual audited novelty outcomes\n\n'+summaries.join('\n\n');
let page,y; const newPage=()=>{page=pdf.addPage([595,842]);y=784;page.drawText('Reader / deterministic protocol evidence',{x:44,y:810,size:9,font,color:rgb(.35,.35,.35)});}; newPage();
for(const paragraph of markdown.split('\n')) {
 const title=/^#{1,2} /.test(paragraph), text=paragraph.replace(/^#{1,2} /,''); const size=title?15:10;
 let line=''; const lines=[];
 for(const ch of text) { if(font.widthOfTextAtSize(line+ch,size)>507 && line) {lines.push(line);line='';} line+=ch; }
 lines.push(line);
 for(const l of lines) {if(y<58)newPage();if(l)page.drawText(l,{x:44,y,size,font});y-=title?23:16;}
 y-=4;
}
for(const [i,p] of pdf.getPages().entries())p.drawText(`${i+1} / ${pdf.getPageCount()}`,{x:510,y:28,size:9,font});
const data=await pdf.save();writeFileSync(join(out,'research-report.pdf'),data);
r.artifacts['research-report.pdf']=createHash('sha256').update(data).digest('hex');r.researchPDFPages=pdf.getPageCount();r.reportGeneratorSHA256=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');writeFileSync(join(out,'result.json'),JSON.stringify(r,null,2));
console.log(`Rendered actual research Markdown: ${pdf.getPageCount()} PDF pages`);
