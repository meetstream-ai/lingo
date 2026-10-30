import {test,expect,chromium} from '@playwright/test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import{tmpdir}from'node:os';import{resolve}from'node:path';
test('Chrome toolbar popup keeps its intrinsic width when opened as an action',async({browserName})=>{
 test.skip(browserName!=='chromium','Chrome action popup');
 const dir=mkdtempSync(`${tmpdir()}/everyvoice-action-`);let context;
 try{
 context=await chromium.launchPersistentContext(dir,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${resolve('extension')}`,`--load-extension=${resolve('extension')}`]});
 let[worker]=context.serviceWorkers();if(!worker)worker=await context.waitForEvent('serviceworker');
 const cdp=await context.newCDPSession(context.pages()[0]);
 await worker.evaluate(()=>chrome.action.openPopup());
 let popupTarget;
 await expect.poll(async()=>{const{targetInfos}=await cdp.send('Target.getTargets');popupTarget=targetInfos.find(t=>t.url===worker.url().replace('background.js','popup.html'));return !!popupTarget;}).toBe(true);
 // The toolbar popup is a Chrome-created target, outside Playwright's tab-page events.
 const{sessionId}=await cdp.send('Target.attachToTarget',{targetId:popupTarget.targetId,flatten:false});
 let next=0;const replies=new Map();
 cdp.on('Target.receivedMessageFromTarget',event=>{if(event.sessionId!==sessionId)return;const data=JSON.parse(event.message);if(data.id){const resolve=replies.get(data.id);replies.delete(data.id);resolve?.(data);}});
 async function command(method,params={}){const id=++next;const result=new Promise(resolve=>replies.set(id,resolve));await cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})});const data=await result;if(data.error)throw Error(data.error.message);return data.result;}
 let geometry;
 await expect.poll(async()=>{const result=await command('Runtime.evaluate',{expression:'JSON.stringify({width:innerWidth,body:document.body?.getBoundingClientRect().width,height:innerHeight,ready:document.readyState})',returnByValue:true});geometry=JSON.parse(result.result.value);return geometry.ready;}).toBe('complete');
 expect(geometry.width).toBe(360);expect(geometry.body).toBe(360);expect(geometry.height).toBeLessThanOrEqual(600);
 const result=await command('Runtime.evaluate',{expression:'document.querySelector("#quick-connect").getBoundingClientRect().width',returnByValue:true});expect(result.result.value).toBeGreaterThan(280);
 const screenshot=await command('Page.captureScreenshot',{format:'png'});writeFileSync('test-results/real-toolbar-popup.png',Buffer.from(screenshot.data,'base64'));

 }finally{await context?.close();rmSync(dir,{recursive:true,force:true});}
});
