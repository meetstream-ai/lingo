import {test,expect,chromium} from '@playwright/test';import {createApp} from '../../server/app.js';
import {resolve} from 'node:path';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';
test('loaded extension recognizes Zoom start and Teams business, cloud and consumer rooms',async({browserName})=>{
 test.skip(browserName!=='chromium','Chrome extension');
 const kit=createApp({database:':memory:',startWorker:false,env:{APP_PASSWORD:'fixture-password',PUBLIC_ORIGIN:'https://kit.example',GOOGLE_TRANSLATE_API_KEY:'fixture'},meetstream:{bots:{}},fetchImpl:async()=>Response.json({data:{translations:[{translatedText:'नमस्ते'}]}})});
 const server=kit.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`,dir=mkdtempSync(`${tmpdir()}/lingo-platforms-`);let context;
 try {
  context=await chromium.launchPersistentContext(dir,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${resolve('extension')}`,`--load-extension=${resolve('extension')}`]});let[worker]=context.serviceWorkers();if(!worker)worker=await context.waitForEvent('serviceworker');
  await context.route(/^https:\/\/(?:[^/]+\.zoom\.us|teams\.(?:microsoft\.com|cloud\.microsoft|live\.com))\//,route=>route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; require-trusted-types-for 'script'"},body:'<!doctype html><html lang="en"><title>Controlled meeting fixture</title><body><h1>Meeting fixture — no real call</h1></body></html>'}));
  const workspace=await context.newPage();await workspace.goto(base+'/workspace/connections');await workspace.getByLabel('Workspace password',{exact:true}).fill('fixture-password');await workspace.getByRole('button',{name:'Sign in',exact:true}).click();await expect(workspace.locator('#login-dialog')).not.toBeVisible();
  const popup=await context.newPage();await popup.goto(worker.url().replace('background.js','popup.html'));await popup.getByLabel('Workspace URL',{exact:true}).fill(base);await popup.getByRole('button',{name:'Connect open workspace',exact:true}).click();await expect(popup.locator('#workspace-connected')).toBeVisible();
  const matrix=[
   ['Zoom web start','https://us02web.zoom.us/j/12345678901?pwd=fixture','https://app.zoom.us/wc/12345678901/start?from=web'],
   ['Teams cloud','https://teams.microsoft.com/meet/123456789012?p=fixture','https://teams.cloud.microsoft/meet/123456789012?webjoin=true'],
   ['Teams legacy','https://teams.microsoft.com/l/meetup-join/19%3ameeting_fixture%40thread.v2/0?context=%7B%7D','https://teams.cloud.microsoft/l/meetup-join/19%3Ameeting_fixture%40thread.v2/0?webjoin=true'],
   ['Teams consumer','https://teams.live.com/meet/123456789012?p=fixture','https://teams.live.com/meet/123456789012?from=web']
  ];
  for(const [title,invitation,url] of matrix) {
   const call=await context.newPage();await call.goto(url);
   const result=await popup.evaluate(async({title,invitation,url})=>{const[tab]=await chrome.tabs.query({url});await chrome.tabs.update(tab.id,{active:true});return chrome.runtime.sendMessage({type:'LAUNCH',input:{title,meetingLink:invitation,source:'en',targets:['hi'],liveProvider:'deepgram_streaming',postCallProvider:'deepgram',translationProvider:'google'}});},{title,invitation,url});
   expect(result.ok).toBe(true);const m=kit.store.meeting(result.data.meeting.id);expect(new URL(m.meetingLink).searchParams.get(title==='Zoom web start'?'pwd':'p')).toBe(title==='Teams legacy'?null:'fixture');
   kit.store.insertCue({id:'cue-'+m.id,meetingId:m.id,kind:'live',source:'en',start:0,end:1,speaker:'Test speaker',text:'Hello team',receivedAt:Date.now(),translations:{hi:{status:'ready',text:'नमस्ते टीम।'}}});await expect(call.locator('#everyvoice-caption-overlay')).toBeAttached();await expect(call.locator('#translated')).toHaveText('नमस्ते टीम।');await expect(call.locator('#providers')).toContainText('Deepgram');
   await call.screenshot({path:`test-results/platform-${title.replaceAll(' ','-')}.png`});
  }
  expect(kit.store.meetings()).toHaveLength(4);
 }finally{await context?.close();await kit.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
