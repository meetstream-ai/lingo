import test from 'node:test';import assert from 'node:assert/strict';
import {createApp}from'../server/app.js';import{meetingRoom}from'../server/extension.js';
test('workspace grants are single-use, scoped and revocable; concurrent room launches share one bot job',async()=>{
 const kit=createApp({database:':memory:',startWorker:false,env:{APP_PASSWORD:'test-password',PUBLIC_ORIGIN:'https://kit.example',GOOGLE_TRANSLATE_API_KEY:'not-a-real-key'},meetstream:{bots:{}},fetchImpl:async()=>{await new Promise(r=>setTimeout(r,30));return Response.json({data:{translations:[{translatedText:'नमस्ते'}]}});}});
 const server=kit.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 const call=(path,body,headers={})=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
 try{
 assert.equal((await call('/api/extension/authorize',{})).status,401);
 const login=await call('/api/login',{password:'test-password'}),owner={Cookie:login.headers.get('set-cookie').split(';')[0]};
 const grant=await(await call('/api/extension/authorize',{},owner)).json();const access=await(await call('/extension-api/connect',{code:grant.code})).json();const auth={Authorization:`Bearer ${access.token}`};
 assert.equal((await call('/extension-api/connect',{code:grant.code})).status,401);
 assert.equal((await call('/extension-api/captions',undefined,auth)).status,401);
 const config=await(await call('/extension-api/workspace',undefined,auth)).json();assert.equal(config.config.providers.google,true);assert.ok(!JSON.stringify(config).includes('not-a-real-key'));
 kit.store.saveMeeting({id:'legacy-homepage',mode:'live',status:'live',meetingLink:'https://meet.google.com/',source:'en',targets:['hi']});
 const input={title:'Extension call',meetingLink:'https://meet.google.com/abc-defg-hij',source:'en',targets:['hi'],liveProvider:'deepgram_streaming',postCallProvider:'deepgram',translationProvider:'google'};
 const responses=await Promise.all([call('/extension-api/workspace/meetings',input,auth),call('/extension-api/workspace/meetings',{...input,targets:['en']},auth)]);for(const r of responses)assert.equal(r.status,201);
 kit.store.db.prepare('DELETE FROM meetings WHERE id=?').run('legacy-homepage');
 const sessions=await Promise.all(responses.map(r=>r.json()));assert.equal(sessions[0].meeting.id,sessions[1].meeting.id);assert.equal(kit.store.meetings().length,1);assert.equal(kit.store.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='create'").get().n,1);assert.deepEqual(new Set(kit.store.meetings()[0].targets),new Set(['hi','en']));
 const child={Authorization:`Bearer ${sessions[0].token}`};assert.equal((await call('/extension-api/workspace',undefined,child)).status,401);assert.equal((await call('/extension-api/captions',undefined,child)).status,200);
 const wrong=await call('/extension-api/workspace/meetings',{...input,meetingLink:'https://meet.google.com/'},auth);assert.equal(wrong.status,409);assert.equal(kit.store.meetings().length,1);
 assert.equal((await call('/extension-api/workspace/stop',{meetingId:sessions[0].meeting.id},child)).status,401);
 assert.equal((await call('/extension-api/workspace/stop',{meetingId:sessions[0].meeting.id},auth)).status,202);
 const next=await(await call('/extension-api/workspace/meetings',{...input,meetingLink:'https://meet.google.com/xyz-uvwx-abc'},auth)).json();assert.notEqual(next.meeting.id,sessions[0].meeting.id);
 await call('/api/extension/revoke',{},owner);assert.equal((await call('/extension-api/workspace',undefined,auth)).status,401);assert.equal((await call('/extension-api/captions',undefined,child)).status,401);
 }finally{await kit.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('supported room identities reject homepages and preserve Zoom join equivalence',()=>{
 assert.equal(meetingRoom('https://meet.google.com/abc-defg-hij?authuser=0'),'meet.google.com/abc-defg-hij');
 assert.equal(meetingRoom('https://meet.google.com/meet/abc-defg-hij?authuser=0'),'meet.google.com/abc-defg-hij');
 assert.equal(meetingRoom('https://us05web.zoom.us/j/12345678901?pwd=private'),meetingRoom('https://zoom.us/wc/12345678901/join'));
 for(const url of ['https://meet.google.com/','https://zoom.us/','https://evil.example/abc-defg-hij','http://meet.google.com/abc-defg-hij','https://user:pass@meet.google.com/abc-defg-hij'])assert.throws(()=>meetingRoom(url));
});

test('active Google Meet call URL is normalized to the standard bot invitation',async()=>{
 const {validateMeeting}=await import('../server/core.js');
 const input=validateMeeting({title:'Active call',mode:'live',meetingLink:'https://meet.google.com/meet/abc-defg-hij?authuser=0',source:'en',targets:['hi']});
 assert.equal(input.meetingLink,'https://meet.google.com/abc-defg-hij?authuser=0');
 for(const url of ['https://meet.google.com/meet/','https://meet.google.com/meet/abc-defg-hij/other','https://meet.google.com/meet/abc-defg-hij.evil'])assert.throws(()=>validateMeeting({...input,meetingLink:url}));
});
