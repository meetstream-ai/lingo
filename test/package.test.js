import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{packageExtension}from'../scripts/package-extension.js';
test('download packages use relative filenames, include runnable source and omit private state',()=>{
 assert.match(readFileSync('README.md','utf8'),/^# Lingo\n/);
 assert.match(readFileSync('QUICKSTART.md','utf8'),/^# Lingo quickstart\n/);
 packageExtension();
 for(const file of ['extension','starter-kit']){
  const data=readFileSync(`public/${file}.zip`),names=[];let offset=0;
  while(data.readUInt32LE(offset)===0x04034b50){const size=data.readUInt32LE(offset+18),len=data.readUInt16LE(offset+26),extra=data.readUInt16LE(offset+28);names.push(data.subarray(offset+30,offset+30+len).toString());offset+=30+len+extra+size;}
  assert.ok(names.length>5);assert.ok(names.every(n=>!n.startsWith('/')&&!n.includes('..')&&!/^(data|node_modules|dist)\//.test(n)&&n!=='.env'&&!n.endsWith('.sqlite')));
  assert.ok(names.includes('extension/manifest.json'));
  assert.ok(!names.some(n=>n.startsWith('docs/evidence/') || /^docs\/measurements-/.test(n) || n==='docs/VERIFICATION.md'));
  if(file==='starter-kit')for(const n of ['server/app.js','test/workspace-extension.test.js','scripts/start.js','LICENSE','playwright.config.js','README.md','QUICKSTART.md','.github/workflows/ci.yml'])assert.ok(names.includes(n),n);
 }
});
