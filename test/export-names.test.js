import test from'node:test';import assert from'node:assert/strict';import{exportFilename,exportArtifact}from'../server/exports.js';
test('export names use meeting date in IST with day/month/year, weekday, time and a fresh unique suffix',()=>{
 const m={title:'DevRel catch-up',createdAt:Date.parse('2026-10-14T15:14:15Z')};
 const a=exportFilename(m,'final-ta','vtt'),b=exportFilename(m,'final-ta','vtt');
 assert.match(a,/^DevRel-catch-up_14-10-2026_Wednesday_20-44-15_IST_[a-f0-9-]{36}-final-ta\.vtt$/);assert.notEqual(a,b);
 assert.match(exportFilename({...m,createdAt:Date.parse('2026-10-14T20:00:00Z')},'archive','json'),/_15-10-2026_Thursday_01-30-00_IST_/);
 const malicious=exportFilename({...m,title:'../ தமிழ்/மொழி\r\n meeting: *?'.repeat(5)},'notes','txt');assert.ok(!/[\r\n/:*?]/.test(malicious));assert.ok(Buffer.byteLength(malicious)<255);assert.match(malicious,/தமிழ்/);
 const cue={kind:'final',start:0,end:1,speaker:'Speaker',text:'Hello',translations:{hi:{status:'ready',text:'नमस्ते'}}};
 for(const format of ['txt','vtt','srt','md','html','json']){const artifact=exportArtifact(m,[cue],{format,target:'hi',kind:'final'});assert.match(artifact.filename,/_14-10-2026_Wednesday_20-44-15_IST_/);assert.ok(artifact.filename.endsWith(`-final-hi.${format}`));}
});
