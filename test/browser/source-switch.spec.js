import {test,expect,chromium} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {createApp} from '../../server/app.js';
import {resolve} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
const fixtureMeeting={id:'language-part',title:'GTM sync-up',mode:'live',source:'hi',targets:['en'],liveProvider:'deepgram_streaming',postCallProvider:'deepgram',translationProvider:'google',meetingLink:'https://meet.google.com/abc-defg-hij',createdAt:Date.now(),botId:'previous-bot',status:'live',postCallStatus:'pending'};
function fixture(env={}) {
 return createApp({database:':memory:',startWorker:false,env:{...env,PUBLIC_ORIGIN:'https://kit.example',GOOGLE_TRANSLATE_API_KEY:'fixture'},meetstream:{bots:{remove:async()=>({status:'stopped'}),status:async()=>({status:'Stopped'}),create:async()=>({bot_id:'next-bot'})}},fetchImpl:async()=>Response.json({data:{translations:[{translatedText:'Hello'}]}})});
}
test('spoken language restart explains interruption, validates language and links earlier recording parts',async({page})=>{
 const kit=fixture();kit.store.saveMeeting({...fixtureMeeting});const server=kit.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 try {
  await page.goto(base+'/workspace/meetings/language-part');await page.getByRole('button',{name:'Spoken language',exact:true}).click();
  await expect(page.locator('#spoken-dialog')).toContainText('Captions pause during the switch');await page.getByLabel('New spoken language',{exact:true}).selectOption('ta');
  expect(await page.locator('#spoken-source option[value=hi]').count()).toBe(0);
  let axe=await new AxeBuilder({page}).include('#spoken-dialog').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(axe.violations).toEqual([]);
  await page.screenshot({path:`test-results/lingo-language-switch-${test.info().project.name}.png`});
  await page.getByRole('button',{name:'Restart captions in new language',exact:true}).click();await expect(page.locator('#spoken-dialog')).not.toBeVisible();await expect(page.locator('#recording-parts')).toContainText('Changing spoken language');
  await kit.tick();await expect.poll(()=>kit.store.meeting(fixtureMeeting.id).nextMeetingId).toBeTruthy();
  await expect(page.getByRole('link',{name:'Continue to next recording part'})).toBeVisible();await page.getByRole('link',{name:'Continue to next recording part'}).click();
  await expect(page.locator('#meeting-services')).toContainText('Tamil');await expect(page.getByRole('link',{name:'Previous recording part'})).toBeVisible();await page.getByRole('link',{name:'Previous recording part'}).click();await expect(page.locator('#meeting-services')).toContainText('Hindi');
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 } finally {await kit.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('loaded extension switches recognizer and follows the new recording without changing another room',async({browserName})=>{
 test.skip(browserName!=='chromium','Chrome MV3 extension');
 const kit=fixture({APP_PASSWORD:'fixture-password'});kit.store.saveMeeting({...fixtureMeeting});kit.store.saveMeeting({...fixtureMeeting,id:'other-room',meetingLink:'https://meet.google.com/xyz-uvwx-abc',source:'ta'});
 const server=kit.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`,dir=mkdtempSync(`${tmpdir()}/lingo-switch-`);let context;
 try{
  context=await chromium.launchPersistentContext(dir,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${resolve('extension')}`,`--load-extension=${resolve('extension')}`]});let[worker]=context.serviceWorkers();if(!worker)worker=await context.waitForEvent('serviceworker');
  await context.route('https://meet.google.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><title>Meeting fixture</title><body><h1>Isolated call fixture</h1></body></html>'}));
  const workspace=await context.newPage();await workspace.goto(base+'/workspace/connections');await workspace.getByLabel('Workspace password').fill('fixture-password');await workspace.getByRole('button',{name:'Sign in',exact:true}).click();await expect(workspace.locator('#login-dialog')).not.toBeVisible();
  const popup=await context.newPage();await popup.goto(worker.url().replace('background.js','popup.html'));await popup.getByLabel('Workspace URL').fill(base);await popup.getByRole('button',{name:'Connect open workspace',exact:true}).click();await expect(popup.locator('#workspace-connected')).toBeVisible();
  const meeting=await context.newPage();await meeting.goto(fixtureMeeting.meetingLink);
  const send=(type,values={})=>popup.evaluate(async({type,values,url})=>{const[tab]=await chrome.tabs.query({url});await chrome.tabs.update(tab.id,{active:true});return chrome.runtime.sendMessage({type,...values});},{type,values,url:meeting.url()});
  expect((await send('SESSION',{meetingId:fixtureMeeting.id})).ok).toBe(true);await popup.evaluate(()=>refresh());
  await popup.locator('#session-source').click();await popup.getByLabel('New spoken language').selectOption('ta');
  await popup.getByRole('button',{name:'Restart captions in new language',exact:true}).click();await expect.poll(()=>kit.store.meeting(fixtureMeeting.id).languageSwitch?.source).toBe('ta');
  await kit.tick();await expect.poll(()=>kit.store.meeting(fixtureMeeting.id).nextMeetingId).toBeTruthy();const next=kit.store.meeting(kit.store.meeting(fixtureMeeting.id).nextMeetingId);
  kit.store.insertCue({id:'next-turn',meetingId:next.id,kind:'live',start:1,end:2,source:'ta',speaker:'Ananya',text:'வணக்கம்',receivedAt:Date.now(),translations:{en:{status:'ready',text:'Hello from the next recording'}}});
  await expect(meeting.locator('#translated')).toHaveText('Hello from the next recording');await popup.evaluate(()=>refresh());await expect(popup.locator('#session-source')).toContainText('Tamil');
  expect(kit.store.meeting('other-room').source).toBe('ta');expect(kit.store.meeting('other-room').languageSwitch).toBeUndefined();
  const axe=await new AxeBuilder({page:popup}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(axe.violations).toEqual([]);await popup.screenshot({path:'test-results/lingo-extension-language.png',clip:{x:0,y:0,width:360,height:600}});
 }finally{await context?.close();await kit.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
