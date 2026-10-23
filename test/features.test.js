import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server/app.js';
import {meetingSummary} from '../server/summaries.js';
import {translatedAudio} from '../server/providers.js';
async function serve(options={}){const kit=createApp({database:':memory:',env:{},startWorker:false,...options});const server=kit.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;return {...kit,request:(path,body,headers={})=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})}),close:async()=>{await kit.close();server.closeAllConnections();await new Promise(r=>server.close(r));}};}
const input={title:'Guarded call',mode:'live',meetingLink:'https://meet.google.com/abc-defg-hij',source:'en',targets:['hi'],liveProvider:'deepgram_streaming',postCallProvider:'deepgram',translationProvider:'google'};
test('failed translation probe and known speech failure cannot create meetings or bot jobs',async()=>{
 let probes=0;const kit=await serve({env:{PUBLIC_ORIGIN:'https://kit.example',GOOGLE_TRANSLATE_API_KEY:'private-key'},meetstream:{bots:{}},fetchImpl:async()=>{probes++;return new Response('{}',{status:401});}});
 try{const r=await kit.request('/api/meetings',input);assert.equal(r.status,409);assert.match((await r.json()).error,/No bot was created/);assert.equal(kit.store.meetings().length,0);assert.equal(kit.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n,0);
 const c=await(await kit.request('/api/config')).json();assert.equal(c.connections.find(c=>c.id==='google').check.upstreamStatus,401);
 // A real failed lifecycle callback binds the managed check to this API key.
 kit.store.saveMeeting({...input,id:'failed',botId:'bad-bot',liveToken:'callback-token',createdAt:1,status:'live',postCallStatus:'pending',liveProvider:'jigsawstack_streaming'});
 // Worker is off here; use a persisted connection result through its public test route in a separate test below.
 const blank=await kit.request('/api/meetings',{...input,translationProvider:''});assert.equal(blank.status,400);assert.equal(probes,1);
 }finally{await kit.close();}
});
test('summary excerpts preserve translated turns, timestamps, language and cached downloads',async()=>{
 const kit=await serve();try{
 const m={id:'summary',title:'Meeting',mode:'live',source:'ta',targets:['en','hi'],translationProvider:'google',createdAt:1,status:'completed'};kit.store.saveMeeting(m);
 for(let i=0;i<8;i++)kit.store.insertCue({id:`c${i}`,meetingId:m.id,kind:'final',speaker:'Karthik',source:'ta',start:i,end:i+1,text:`Original ${i}`,translations:{en:{status:'ready',text:`English ${i}.`},hi:{status:'ready',text:`हिन्दी ${i}।`}}});
 const first=await kit.request('/api/meetings/summary/summary',{target:'hi',kind:'excerpts'});assert.equal(first.status,200);const s=await first.json();assert.equal(s.points.length,6);assert.equal(s.points.at(-1).start,7);assert.equal(s.target,'hi');assert.equal(s.kind,'excerpts');
 const second=await(await kit.request('/api/meetings/summary/summary',{target:'hi',kind:'excerpts'})).json();assert.equal(s.generatedAt,second.generatedAt);
 const download=await kit.request('/api/meetings/summary/summary.txt?target=hi');assert.match(await download.text(),/हिन्दी 7/);
 const ai=await kit.request('/api/meetings/summary/summary',{target:'hi',kind:'ai'});assert.equal(ai.status,502);assert.match((await ai.json()).error,/Configure/);assert.equal(kit.store.meeting(m.id).summaries.hi.generatedAt,s.generatedAt);
 const missing=await kit.request('/api/meetings/summary/summary',{target:'de'});assert.equal(missing.status,400);
 }finally{await kit.close();}
});
test('AI summary uses original transcript and translates validated output into the requested language',async()=>{
 const seen=[];const env={JIGSAWSTACK_API_KEY:'private-summary-key',GOOGLE_TRANSLATE_API_KEY:'translation-key'};
 const fetchImpl=async(url,opts)=>{const body=JSON.parse(opts.body);seen.push({url,body});return url.endsWith('/summary')?Response.json({success:true,summary:['Ship Friday.']}):Response.json({data:{translations:[{translatedText:'शुक्रवार को भेजें।',detectedSourceLanguage:'en'}]}});};
 const result=await meetingSummary([{id:'a',kind:'final',speaker:'Arjun',text:'We agreed to ship on Friday.',translations:{}}],'hi','ai',{translationProvider:'google'},env,fetchImpl);
 assert.equal(result.points[0].text,'शुक्रवार को भेजें।');assert.match(seen[0].body.text,/Arjun:/);assert.equal(seen[1].body.target,'hi');assert.equal(seen[1].body.source,undefined);
});
test('cloud read-aloud matches a Hindi voice, validates byte limits and scopes transcript access',async()=>{
 const env={GOOGLE_TTS_API_KEY:'isolated-speech-key'},seen=[];const fetchImpl=async(url,opts)=>{seen.push({url,opts});return url.endsWith('/voices')?Response.json({voices:[{name:'hi-IN-Standard-A',languageCodes:['hi-IN']}]}):Response.json({audioContent:Buffer.from('mock-audio').toString('base64')});};
 const audio=await translatedAudio('नमस्ते','hi',env,fetchImpl);assert.equal(audio.language,'hi-IN');assert.equal(JSON.parse(seen[1].opts.body).voice.name,'hi-IN-Standard-A');await assert.rejects(()=>translatedAudio('x'.repeat(5001),'hi',env,fetchImpl),/5,000/);await assert.rejects(()=>translatedAudio('Hello','de',env,fetchImpl),/no voice/);
 const kit=await serve({env,fetchImpl});try{
 kit.store.saveMeeting({id:'one',targets:['hi']});kit.store.saveMeeting({id:'other',targets:['hi']});kit.store.insertCue({id:'foreign',meetingId:'other',kind:'final',start:1,translations:{hi:{status:'ready',text:'नमस्ते'}}});
 assert.equal((await kit.request('/api/meetings/one/speech',{target:'hi',cueId:'foreign'})).status,409);
 assert.equal((await kit.request('/api/meetings/one/speech',{target:'de',cueId:'foreign'})).status,400);
 }finally{await kit.close();}
});

test('known speech authentication failures block before a translation probe or bot creation',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const{tmpdir}=await import('node:os');const{join}=await import('node:path');const{openConnections}=await import('../server/connections.js');
 const dir=mkdtempSync(join(tmpdir(),'kit-preflight-')),path=join(dir,'connections.json'),env={PUBLIC_ORIGIN:'https://kit.example',MEETSTREAM_API_KEY:'workspace-test-key',GOOGLE_TRANSLATE_API_KEY:'test-key'};
 openConnections(path,{...env}).setCheck('jigsawstack_asr',{status:'failed',message:'JigsawStack authentication failed (HTTP 401).',at:Date.now()});let probes=0;const kit=await serve({env,connectionsPath:path,meetstream:{bots:{}},fetchImpl:async()=>{probes++;return Response.json({});}});
 try{const r=await kit.request('/api/meetings',{...input,liveProvider:'jigsawstack_streaming',postCallProvider:'jigsawstack'});assert.equal(r.status,409);assert.match((await r.json()).error,/HTTP 401/);assert.equal(probes,0);assert.equal(kit.store.meetings().length,0);}finally{await kit.close();rmSync(dir,{recursive:true,force:true});}
});

test('recovery can switch providers after an earlier request completed but its transcript failed, and duplicates do not bill twice',async()=>{
 const kit=await serve({meetstream:{bots:{audio:async()=>({audio_mp3_url:'https://fixture.s3.amazonaws.com/audio.mp3'})}}});try{
 kit.store.saveMeeting({id:'recover',title:'Call',mode:'live',botId:'bot',endedAt:1,status:'stopped',postCallStatus:'failed',source:'en',postCallProvider:'jigsawstack',targets:['hi'],lastError:'Speech failed'});
 kit.store.enqueue('retranscribe:recover','retranscribe',{meetingId:'recover'});kit.store.done('retranscribe:recover');
 for(let i=0;i<2;i++)assert.equal((await kit.request('/api/meetings/recover/retranscribe',{provider:'deepgram',source:'en'})).status,202);
 const jobs=kit.store.db.prepare("SELECT id FROM jobs WHERE kind='retranscribe' AND status='queued'").all();assert.equal(jobs.length,1);assert.notEqual(jobs[0].id,'retranscribe:recover');assert.equal(kit.store.meeting('recover').postCallProvider,'deepgram');assert.equal(kit.store.meeting('recover').transcriptHistory.length,1);assert.equal(kit.store.meeting('recover').transcriptHistory[0].provider,'jigsawstack');
 }finally{await kit.close();}
});

test('extension read-aloud is authenticated, meeting-scoped and credential-free',async()=>{
 const kit=await serve({env:{APP_PASSWORD:'test-workspace',GOOGLE_TTS_API_KEY:'private-speech-key'},fetchImpl:async url=>url.endsWith('/voices')?Response.json({voices:[{name:'hi-IN-Standard-A',languageCodes:['hi-IN']}]}):Response.json({audioContent:Buffer.from('test-audio').toString('base64')})});
 try{for(const id of ['one','other']){kit.store.saveMeeting({id,title:id,targets:['hi']});kit.store.insertCue({id:`cue-${id}`,meetingId:id,kind:'live',start:1,translations:{hi:{status:'ready',text:'नमस्ते'}}});}
 const login=await kit.request('/api/login',{password:'test-workspace'}),cookie=login.headers.get('set-cookie').split(';')[0];
 const grant=await(await kit.request('/api/extension/pairing',{meetingId:'one'},{Cookie:cookie})).json();const access=await(await kit.request('/extension-api/pair',{code:grant.code})).json();const headers={Authorization:`Bearer ${access.token}`};
 assert.equal((await kit.request('/extension-api/speech',{cueId:'cue-one',target:'hi'})).status,401);
 assert.equal((await kit.request('/extension-api/speech',{cueId:'cue-other',target:'hi'},headers)).status,409);
 const audio=await kit.request('/extension-api/speech',{cueId:'cue-one',target:'hi'},headers);assert.equal(audio.status,200);const data=await audio.json();assert.equal(data.language,'hi-IN');assert.ok(!JSON.stringify(data).includes('private-speech-key'));
 }finally{await kit.close();}
});

test('short development passwords are redacted from upstream diagnostic errors',async()=>{
 const kit=await serve({env:{APP_PASSWORD:'2468'},meetstream:{bots:{list:async()=>{throw Error('Provider diagnostic accidentally echoed 2468');}}}});
 try{const login=await kit.request('/api/login',{password:'2468'});const cookie=login.headers.get('set-cookie').split(';')[0];const result=await kit.request('/api/connections/meetstream/test',{}, {Cookie:cookie});assert.equal(result.status,502);const error=(await result.json()).error;assert.ok(!error.includes('2468'));assert.match(error,/redacted/);}finally{await kit.close();}
});

test('completed meetings automatically save post-call overviews in ready languages and retain current AI summaries',async()=>{
 const kit=await serve();
 try {
  const m={id:'auto-overview',title:'GTM sync-up',mode:'live',source:'hi',targets:['hi','en'],translationProvider:'google',createdAt:1,endedAt:2,status:'completed',postCallStatus:'ready'};kit.store.saveMeeting(m);
  kit.store.insertCue({id:'overview-final',meetingId:m.id,kind:'final',source:'hi',speaker:'Ananya',start:2,end:4,text:'अगला कदम तय करें।',translations:{en:{status:'pending'}}});
  let data=await(await kit.request(`/api/meetings/${m.id}`)).json();assert.equal(data.meeting.summaries.hi.sourceKind,'final');assert.equal(data.meeting.summaries.hi.automatic,true);assert.equal(data.meeting.summaries.en,undefined);
  const c=kit.store.cue('overview-final');c.translations.en={status:'ready',text:'Decide the next step.'};kit.store.saveCue(c);
  data=await(await kit.request(`/api/meetings/${m.id}`)).json();assert.equal(data.meeting.summaries.en.points[0].text,'Decide the next step.');assert.equal(data.meeting.summaries.en.points[0].speaker,'Ananya');
  const generatedAt=data.meeting.summaries.en.generatedAt;data=await(await kit.request(`/api/meetings/${m.id}`)).json();assert.equal(data.meeting.summaries.en.generatedAt,generatedAt);assert.match(await(await kit.request(`/api/meetings/${m.id}/summary.txt?target=en`)).text(),/Decide the next step/);
  const {summaryFingerprint}=await import('../server/summaries.js');const current=kit.store.meeting(m.id);current.summaries.en={...current.summaries.en,kind:'ai',fingerprint:summaryFingerprint(kit.store.cues(m.id),'en','ai'),points:[{text:'Existing AI overview.'}]};kit.store.saveMeeting(current);
  data=await(await kit.request(`/api/meetings/${m.id}`)).json();assert.equal(data.meeting.summaries.en.kind,'ai');assert.equal(data.meeting.summaries.en.points[0].text,'Existing AI overview.');
 }finally{await kit.close();}
});
test('automatic post-call overview is persisted by transcript processing without an open browser',async()=>{
 const kit=await serve({meetstream:{transcripts:{get:async()=>[{speaker:'Ananya',transcript:'The next step is a review.',start_time:0,end_time:2}]}}});
 try {
  const m={id:'headless-overview',title:'Review',mode:'live',source:'en',targets:['en'],translationProvider:'google',createdAt:1,endedAt:2,status:'stopped',postCallStatus:'pending',transcriptId:'fixture-final'};kit.store.saveMeeting(m);kit.store.enqueue('final-overview','final',{meetingId:m.id});
  await kit.tick();for(let i=0;i<100 && kit.store.meeting(m.id).postCallStatus!=='ready';i++)await new Promise(r=>setTimeout(r,10));
  const saved=kit.store.meeting(m.id);assert.equal(saved.postCallStatus,'ready');assert.equal(saved.summaries.en.sourceKind,'final');assert.equal(saved.summaries.en.automatic,true);assert.equal(saved.summaries.en.points[0].text,'The next step is a review.');
 }finally{await kit.close();}
});
