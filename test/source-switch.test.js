import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server/app.js';
import {hostingChecks} from '../scripts/check-hosting.js';
const original={id:'part-1',title:'DevRel catch-up',mode:'live',source:'hi',targets:['en'],liveProvider:'deepgram_streaming',postCallProvider:'deepgram',translationProvider:'google',meetingLink:'https://meet.google.com/abc-defg-hij',createdAt:1,botId:'old-bot',status:'live',postCallStatus:'pending'};
async function fixture(fn,{badTranslation=false}={}) {
 const calls=[];let stopped=false;
 const kit=createApp({database:':memory:',startWorker:false,env:{PUBLIC_ORIGIN:'https://kit.example',GOOGLE_TRANSLATE_API_KEY:'fixture'},meetstream:{bots:{remove:async id=>{calls.push(['remove',id]);return {status:'requested'};},status:async()=>({status:stopped?'Stopped':'InMeeting'}),create:async(payload,opts)=>{calls.push(['create',payload,opts]);return {bot_id:'new-bot'};}}},fetchImpl:async()=>badTranslation?Response.json({error:{message:'Key rejected'}},{status:401}):Response.json({data:{translations:[{translatedText:'Hello'}]}})});
 kit.store.saveMeeting({...original});kit.store.insertCue({id:'old-cue',meetingId:original.id,kind:'live',start:12,end:15,speaker:'Ananya',text:'नमस्ते',translations:{en:{status:'ready',text:'Hello'}}});
 const server=kit.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const tick=async()=>{await kit.tick();await new Promise(r=>setTimeout(r,50));};
 try{await fn({kit,post,tick,calls,stop:()=>{stopped=true;}});}finally{await kit.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
test('language restart confirms old bot stopped, preserves artifacts and creates exactly one linked session',async()=>fixture(async({kit,post,tick,calls,stop})=>{
 const replies=await Promise.all([post('/api/meetings/part-1/source',{source:'ta',confirmed:true}),post('/api/meetings/part-1/source',{source:'ta',confirmed:true})]);for(const r of replies)assert.equal(r.status,202);
 await tick();assert.equal(kit.store.meetings().length,1);assert.equal(calls.some(c=>c[0]==='create'),false);assert.equal(kit.store.meeting('part-1').source,'hi');
 stop();kit.store.db.prepare("UPDATE jobs SET run_at=0 WHERE kind='switch-source'").run();await tick();
 const previous=kit.store.meeting('part-1'),next=kit.store.meeting(previous.nextMeetingId);assert.equal(next.source,'ta');assert.equal(next.previousMeetingId,previous.id);assert.equal(next.meetingLink,original.meetingLink);assert.equal(next.title,original.title);assert.equal(previous.languageSwitch.status,'ready');assert.ok(previous.endedAt);assert.equal(kit.store.cue('old-cue').start,12);assert.equal(kit.store.cue('old-cue').speaker,'Ananya');assert.equal(kit.store.cue('old-cue').meetingId,previous.id);
 assert.equal((await post('/api/meetings/part-1/source',{source:'ta',confirmed:true})).status,202);assert.equal(kit.store.meetings().length,2);
 await tick();assert.equal(calls.filter(c=>c[0]==='create').length,1);assert.equal(calls.find(c=>c[0]==='create')[2].idempotencyKey,next.id);
}));
test('unsupported source or unconfirmed restart cannot stop a bot',async()=>fixture(async({post,tick,calls})=>{
 for(const body of [{source:'ta'},{source:'xx',confirmed:true},{source:'auto',confirmed:true}])assert.equal((await post('/api/meetings/part-1/source',body)).status,409);
 await tick();assert.equal(calls.length,0);
}));
test('failed translation preflight leaves current recognition running',async()=>fixture(async({kit,post,tick,calls})=>{
 assert.equal((await post('/api/meetings/part-1/source',{source:'ta',confirmed:true})).status,409);await tick();assert.equal(calls.length,0);assert.equal(kit.store.meeting('part-1').status,'live');assert.equal(kit.store.meeting('part-1').languageSwitch,undefined);
},{badTranslation:true}));
test('ending recording cancels a pending source switch and never creates a new bot',async()=>fixture(async({kit,post,tick,calls})=>{
 await post('/api/meetings/part-1/source',{source:'ta',confirmed:true});await post('/api/meetings/part-1/stop',{});await tick();assert.equal(kit.store.meetings().length,1);assert.equal(kit.store.meeting('part-1').languageSwitch.cancelled,true);assert.ok(calls.some(c=>c[0]==='remove'));assert.ok(!calls.some(c=>c[0]==='create'));
}));
test('hosting readiness requires durable configuration and strong hosted credentials',()=>{
 assert.ok(hostingChecks({}).some(([,pass])=>!pass));const checks=hostingChecks({NODE_ENV:'production',HOST:'0.0.0.0',PUBLIC_ORIGIN:'https://lingo.example',APP_PASSWORD:'long-private-password',SESSION_SECRET:'x'.repeat(32),NGROK_ENABLED:'false',DATABASE_PATH:'/data/meetings.sqlite'});assert.ok(checks.every(([,pass])=>pass));assert.ok(!hostingChecks({PUBLIC_ORIGIN:'https://bad.example/path'}).find(([n])=>n==='Public HTTPS origin')[1]);
});
test('native automatic and English-only speech cannot claim an unsupported recognizer language update',async()=>fixture(async({kit,post,tick,calls})=>{
 for(const liveProvider of ['meetstream_streaming','assemblyai_streaming']) {
  kit.store.saveMeeting({...original,source:'en',liveProvider});
  assert.equal((await post('/api/meetings/part-1/source',{source:'ta',confirmed:true})).status,409);
 }
 await tick();assert.equal(calls.length,0);
}));
