import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openConnections,testConnection} from '../server/connections.js';

test('environment key rotation invalidates only diagnostics bound to changed credentials',()=>{
  const dir=mkdtempSync(join(tmpdir(),'meetstream-key-binding-'));
  try {
    const path=join(dir,'connections.json');
    const first=openConnections(path,{MEETSTREAM_API_KEY:'previous-key',GOOGLE_TRANSLATE_API_KEY:'same-google-key'});
    for(const id of ['meetstream','deepgram','assemblyai','jigsawstack_asr','google']) first.setCheck(id,{status:'passed',message:'old result'});
    const next=openConnections(path,{MEETSTREAM_API_KEY:'new-key',GOOGLE_TRANSLATE_API_KEY:'same-google-key'});
    for(const id of ['meetstream','deepgram','assemblyai','jigsawstack_asr']) assert.equal(next.check(id),null);
    assert.equal(next.check('google').status,'passed');
    assert.equal(next.list().find(c=>c.id==='meetstream').check,null);
    next.setCheck('deepgram',{status:'processing',transcriptId:'new-test'});
    assert.equal(openConnections(path,{MEETSTREAM_API_KEY:'new-key'}).check('deepgram').transcriptId,'new-test');
    assert.equal(openConnections(path,{MEETSTREAM_API_KEY:'another-key'}).check('deepgram'),null);
    assert.ok(!JSON.stringify(next.list()).includes('new-key'));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('DeepL browser configuration is private, uses its own test pair and exposes no key',async()=>{
 const env={};const connections=openConnections(null,env);
 connections.save('deepl',{values:{DEEPL_API_KEY:'fixture:fx'}});
 const row=connections.list().find(c=>c.id==='deepl');assert.equal(row.configured,true);assert.ok(!JSON.stringify(row).includes('fixture:fx'));
 const message=await testConnection('deepl',env,null,async(url,opts)=>{assert.equal(url,'https://api-free.deepl.com/v2/translate');assert.deepEqual(JSON.parse(opts.body),{text:['Bonjour'],source_lang:'FR',target_lang:'EN-US'});return Response.json({translations:[{text:'Hello',detected_source_language:'FR'}]});});
 assert.match(message,/French → English/);
});
