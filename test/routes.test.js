import test from'node:test';import assert from'node:assert/strict';import{createApp}from'../server/app.js';
test('workspace paths serve direct links, legacy URLs redirect, analytics stay on home and unknown pages return 404',async()=>{
 const kit=createApp({database:':memory:',env:{},startWorker:false}),server=kit.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{for(const path of ['/workspace/meetings','/workspace/connections','/workspace/health','/workspace/captions','/workspace/meetings/abc','/workspace/meetings/abc/transcript']){const r=await fetch(base+path);assert.equal(r.status,200);assert.match(await r.text(),/id="meeting-services"/);}
 for(const [path,destination]of[['/workspace?view=settings','/workspace/connections'],['/?view=sessions&page=2','/workspace/meetings?page=2'],['/workspace?view=captions&meeting=abc&panel=summary&kind=final','/workspace/meetings/abc/summary?kind=final'],['/index.html','/workspace/captions']]){const r=await fetch(base+path,{redirect:'manual'});assert.equal(r.status,302);assert.equal(r.headers.get('location'),destination);}
 assert.match(await(await fetch(base+'/?utm_source=test')).text(),/The meeting stays/);
 for(const path of ['/workspace/nothing','/workspace/meetings/abc/not-a-panel','/does-not-exist']){const r=await fetch(base+path);assert.equal(r.status,404);assert.match(await r.text(),/Page not found/);}
 }finally{await kit.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
