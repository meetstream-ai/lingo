import { test, expect, chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createApp } from '../../server/app.js';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

test('homepage demonstrates languages, links to workspace, and remains accessible on mobile', async ({page}) => {
  const errors=[]; page.on('pageerror', e=>errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading',{level:1})).toHaveText('The meeting stays.Your language changes.');
  await page.getByLabel('Read in').selectOption('ta');
  await expect(page.locator('#preview-translation')).toContainText('அடுத்த');
  let axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze(); expect(axe.violations).toEqual([]);
  await page.screenshot({path:'test-results/home-desktop.png',fullPage:true});
  await page.setViewportSize({width:360,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze(); expect(axe.violations).toEqual([]);
  await page.screenshot({path:'test-results/home-mobile.png',fullPage:true});
  await page.getByRole('link',{name:'Set up Chrome overlay'}).click();
  await expect(page.getByRole('heading',{level:1})).toHaveText('Read captions over your meeting.');
  expect(errors).toEqual([]);
});

test('provider selection searches the real catalog and rejects unsupported live combinations', async ({page}) => {
  await page.route('**/api/config',async route=>{const response=await route.fetch();const config=await response.json();config.providers.jigsawstack=true;await route.fulfill({response,json:config});});
  await page.goto('/workspace');
  await page.locator('[data-new-meeting]').first().click();
  await page.locator('input[name=mode][value=live]').check();
  await page.locator('select[name=translationProvider]').selectOption('jigsawstack');
  await page.getByLabel('Find a translation language').fill('Korean');
  await expect(page.locator('#target-options label:visible')).toHaveCount(3); // two selected plus searched language
  await page.locator('input[name=targets][value=ko]').check();
  await page.locator('select[name=liveProvider]').selectOption('assemblyai_streaming');
  await expect(page.locator('#source-language')).toHaveValue('en');
  await page.locator('select[name=liveProvider]').selectOption('jigsawstack_streaming');
  await expect(page.locator('#post-call-provider')).toHaveValue('jigsawstack');
  await page.locator('input[name=meetingLink]').fill('https://zoom.us/j/123456789');
  await page.getByRole('button',{name:'Join meeting',exact:true}).click();
  await expect(page.locator('#new-error')).toContainText('Google Meet');
  const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze(); expect(axe.violations).toEqual([]);
});

test('failed bot creation is explicit and the logo opens home with working Back navigation', async ({page}) => {
  const kit=createApp({env:{PUBLIC_ORIGIN:'https://kit.example',GOOGLE_TRANSLATE_API_KEY:'mock'},database:':memory:',meetstream:{bots:{create:async()=>{throw Object.assign(new Error('DeepgramAPIKey is not configured in user profile.'),{status:400});}}},fetchImpl:async()=>Response.json({data:{translations:[{translatedText:'नमस्ते'}]}})});
  const server=kit.app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    await page.goto(base+'/workspace');
    await page.getByRole('button',{name:'New meeting',exact:true}).click();
    await page.getByRole('radio',{name:'Real meeting Uses your configured providers'}).check();
    await page.getByLabel('Meeting URL',{exact:true}).fill('https://meet.google.com/abc-defg-hij');
    await page.getByRole('combobox',{name:'Live transcription',exact:true}).selectOption('deepgram_streaming');
    await page.getByRole('combobox',{name:'Source language',exact:true}).selectOption('hi');
    await page.getByRole('button',{name:'Join meeting',exact:true}).click();
    await expect(page.locator('#session-status')).toHaveText('Needs attention');
    await expect(page.locator('#stream-status')).toContainText('unavailable');
    await expect(page.locator('#caption-waiting')).toContainText('DeepgramAPIKey');
    await expect(page.locator('#caption-waiting')).not.toContainText('Waiting for speech');
    await page.getByRole('button',{name:'Connections',exact:true}).click();
    await expect(page.getByRole('article').filter({has:page.getByRole('heading',{name:'Deepgram',exact:true})})).toContainText('Live bot creation was rejected');
    const settingsUrl=page.url();
    await page.getByRole('link',{name:'Lingo home',exact:true}).click();
    await expect(page).toHaveURL(base+'/');
    await expect(page.getByRole('heading',{level:1})).toContainText('The meeting stays.');
    await page.goBack();
    await expect(page).toHaveURL(settingsUrl);
    await expect(page.getByRole('heading',{name:'Bring it all together.',exact:true})).toBeVisible();
  } finally { await kit.close();server.closeAllConnections();await new Promise(r=>server.close(r)); }
});

test('loaded Chrome extension pairs with live webhook pipeline, translates overlay, and revokes cleanly', async ({browserName}) => {
  test.skip(browserName !== 'chromium','Manifest V3 extension runs in Chromium');
  const dir=mkdtempSync(`${tmpdir()}/everyvoice-extension-`);
  const sdk={bots:{create:async()=>({bot_id:'extension-bot',transcript_id:'extension-transcript'}),status:async()=>({status:'InMeeting'})}};
  const kit=createApp({env:{APP_PASSWORD:'extension-e2e-password',PUBLIC_ORIGIN:'https://kit.example',GOOGLE_TRANSLATE_API_KEY:'mock-key'},database:':memory:',meetstream:sdk,fetchImpl:async(_url,opts)=>Response.json({data:{translations:[{translatedText:JSON.parse(opts.body).target==='hi'?'नमस्ते सभी को':'Hello everyone',detectedSourceLanguage:'ta'}]}})});
  let interrupted = false;
  const server=createServer((req,res)=>{
    if (interrupted && req.url.startsWith('/extension-api/captions')) { res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Test workspace unavailable'})); }
    else kit.app(req,res);
  }).listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const extension=resolve('extension');
  let context;
  try {
    context=await chromium.launchPersistentContext(dir,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:1280,height:800}});
    let [worker]=context.serviceWorkers(); if(!worker) worker=await context.waitForEvent('serviceworker');
    const extensionId=new URL(worker.url()).host;
    const login=await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'extension-e2e-password'})});
    const headers={'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0]};
    const created=await(await fetch(`${base}/api/meetings`,{method:'POST',headers,body:JSON.stringify({title:'Overlay integration test',mode:'live',source:'ta',targets:['en','hi'],meetingLink:'https://meet.google.com/abc-defg-hij'})})).json();
    await expect.poll(()=>kit.store.meeting(created.id)?.botId).toBe('extension-bot');
    const grant=await(await fetch(`${base}/api/extension/pairing`,{method:'POST',headers,body:JSON.stringify({meetingId:created.id})})).json();
    const popup=await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    for (const width of [360, 420, 600]) {
      await popup.setViewportSize({width,height:600});
      expect(await popup.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const fields=await popup.locator('input:visible,button:visible').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height}}));
      for(const field of fields){expect(field.height).toBeGreaterThanOrEqual(44);expect(field.left).toBeGreaterThanOrEqual(0);expect(field.right).toBeLessThanOrEqual(width);}
    }
    await popup.setViewportSize({width:360,height:600});
    await popup.screenshot({path:'test-results/extension-popup-pair.png'});
    await popup.getByText('Manual connection',{exact:true}).click();
    await popup.getByLabel('Workspace URL').fill(base); await popup.getByLabel('One-time pairing code').fill(grant.code);
    await popup.getByRole('button',{name:'Connect meeting',exact:true}).click();
    await expect(popup.locator('#meeting-title')).toHaveText('Overlay integration test');
    await expect(popup.getByRole('link',{name:'Open paired meeting',exact:true})).toHaveAttribute('href','https://meet.google.com/abc-defg-hij');
    const popupSelect=await popup.locator('#language').evaluate(el=>{const s=getComputedStyle(el);const a=getComputedStyle(el.parentElement,'::after');return {appearance:s.appearance,padding:s.paddingRight,arrowRight:a.right,arrowTop:a.top,arrowBorder:a.borderRightStyle}});
    expect(popupSelect).toEqual({appearance:'none',padding:'38px',arrowRight:'14px',arrowTop:'22px',arrowBorder:'solid'});
    const popupAxe=await new AxeBuilder({page:popup}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(popupAxe.violations).toEqual([]);
    await popup.screenshot({path:'test-results/extension-popup-connected.png'});
    await popup.emulateMedia({forcedColors:'active'});
    await expect(popup.locator('#language')).toHaveCSS('appearance','auto');
    expect(await popup.locator('#connected .select-box').evaluate(el=>getComputedStyle(el,'::after').display)).toBe('none');
    await popup.emulateMedia({forcedColors:'none'});
    kit.store.saveMeeting({...kit.store.meeting(created.id),status:'live'});
    await popup.getByLabel('Read captions in').selectOption('hi');
    await expect(popup.locator('#status')).toHaveText('Caption language updated.');
    await context.route('https://meet.google.com/**', route=>route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; require-trusted-types-for 'script'"},body:'<!doctype html><html lang="en"><head><title>Isolated meeting test fixture</title></head><body><h1>Meeting test fixture</h1><p>This is a simulated meeting page, not a real call.</p></body></html>'}));
    const meeting=await context.newPage(); await meeting.goto('https://meet.google.com/abc-defg-hij');
    // Chrome's popup action is represented by its own extension page in this automated harness.
    // Activate the actual meeting tab, then invoke the popup's runtime action.
    const result=await popup.evaluate(async()=>new Promise(resolve=>{
      chrome.tabs.query({url:'https://meet.google.com/*'},tabs=>chrome.tabs.update(tabs[0].id,{active:true},async()=>resolve(await chrome.runtime.sendMessage({type:'START'}))));
    })); expect(result.ok).toBe(true);
    await expect(meeting.locator('#everyvoice-caption-overlay')).toBeAttached();
    await expect(meeting.locator('#status')).toHaveText('Waiting for speech · bot connected');
    const m=kit.store.meeting(created.id);
    await fetch(`${base}/webhooks/live/${m.id}/${m.liveToken}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bot_id:m.botId,new_text:'வணக்கம் அனைவருக்கும்',transcript:'Previous. வணக்கம் அனைவருக்கும்',speakerName:'Karthik',language_code:'ta',start_time:1,end_time:2,end_of_turn:true})});
    const cdp=await context.newCDPSession(meeting);
    const tree=()=>cdp.send('DOM.getDocument',{depth:-1,pierce:true});
    await expect.poll(async()=>JSON.stringify(await tree())).toContain('नमस्ते सभी को');
    const dom=JSON.stringify(await tree()); expect(dom).toContain('Karthik'); expect(dom).toContain('வணக்கம் அனைவருக்கும்'); expect(dom).not.toContain('mock-key'); expect(dom).not.toContain(grant.code);
    await expect(meeting.locator('#everyvoice-caption-overlay').getByText('नमस्ते सभी को',{exact:true})).toBeVisible();
    await meeting.screenshot({path:'test-results/extension-overlay-compact.png'});
    await meeting.getByRole('button',{name:'Settings',exact:true}).click();
    await meeting.getByRole('button',{name:'Pause',exact:true}).click();
    await expect(meeting.getByRole('button',{name:'Resume',exact:true})).toHaveAttribute('aria-pressed','true');
    interrupted = true;
    await expect(meeting.locator('#status')).toContainText('Paused · Connection interrupted');
    await expect(meeting.locator('#translated')).toHaveText('नमस्ते सभी को');
    interrupted = false;
    await expect(meeting.locator('#status')).toHaveText('Paused · Live translated captions');
    await expect(meeting.locator('#translated')).toHaveText('नमस्ते सभी को');
    await meeting.getByRole('button',{name:'Resume',exact:true}).click();
    await meeting.getByLabel('Caption text size',{exact:true}).selectOption('34');
    await expect(meeting.locator('#translated')).toHaveCSS('font-size','34px');
    await meeting.getByRole('button',{name:'Original',exact:true}).click();
    await expect(meeting.locator('#original')).toBeHidden();
    await meeting.getByRole('button',{name:'Original',exact:true}).click();
    await meeting.getByLabel('Caption position',{exact:true}).selectOption('top');
    await expect(meeting.locator('#everyvoice-caption-overlay')).toHaveCSS('top','24px');
    await meeting.getByRole('button',{name:'Close caption overlay'}).click();
    const reopened = await popup.evaluate(async()=>new Promise(resolve=>{
      chrome.tabs.query({url:'https://meet.google.com/*'},tabs=>chrome.tabs.update(tabs[0].id,{active:true},async()=>resolve(await chrome.runtime.sendMessage({type:'START'}))));
    })); expect(reopened.ok).toBe(true);
    await expect(meeting.getByLabel('Caption text size',{exact:true})).toHaveValue('34');
    await expect(meeting.getByLabel('Caption position',{exact:true})).toHaveValue('top');
    await expect(meeting.locator('#translated')).toHaveCSS('font-size','34px');
    await meeting.getByRole('button',{name:'Settings',exact:true}).click();
    await meeting.getByLabel('Caption position',{exact:true}).selectOption('bottom');
    const axe=await new AxeBuilder({page:meeting}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze(); expect(axe.violations).toEqual([]);
    await meeting.screenshot({path:'test-results/extension-overlay.png'});
    const beforeDrag=await meeting.locator('#everyvoice-caption-overlay').boundingBox();
    const handle=await meeting.getByRole('button',{name:'Move captions with arrow keys or drag',exact:true}).boundingBox();
    await meeting.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await meeting.mouse.down();await meeting.mouse.move(handle.x+handle.width/2+40,handle.y+handle.height/2-30,{steps:4});await meeting.mouse.up();
    await expect(meeting.getByLabel('Caption position',{exact:true})).toHaveValue('custom');
    const afterDrag=await meeting.locator('#everyvoice-caption-overlay').boundingBox();expect(afterDrag.x).toBeCloseTo(beforeDrag.x+40,0);expect(afterDrag.y).toBeCloseTo(beforeDrag.y-30,0);
    await meeting.getByLabel('Caption position',{exact:true}).selectOption('bottom');
    for (const width of [240, 320, 360, 480, 680, 1280]) {
      await meeting.setViewportSize({width,height:800});
      const controls=await meeting.locator('#everyvoice-caption-overlay').locator('button,select').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,appearance:s.appearance,position:s.backgroundPosition,size:s.backgroundSize,padding:s.paddingRight,tag:el.tagName}}));
      for(const [i,control] of controls.entries()) {
        expect(control.left).toBeGreaterThanOrEqual(0);expect(control.right).toBeLessThanOrEqual(width);expect(control.height).toBe(36);
        if(control.tag==='SELECT'){expect(control.appearance).toBe('none');expect(control.padding).toBe('34px');}
        for(const other of controls.slice(i+1)) expect(control.left >= other.right || control.right <= other.left || control.top >= other.bottom || control.bottom <= other.top).toBe(true);
      }
    }
    await meeting.setViewportSize({width:360,height:640});
    await meeting.getByLabel('Caption position',{exact:true}).selectOption('left');
    await expect(meeting.locator('#everyvoice-caption-overlay')).toHaveCSS('left','16px');
    await meeting.getByLabel('Caption position',{exact:true}).selectOption('right');
    await expect(meeting.locator('#everyvoice-caption-overlay')).toHaveCSS('right','16px');
    const move=meeting.getByRole('button',{name:'Move captions with arrow keys or drag',exact:true});
    await move.focus();await move.press('ArrowUp');
    await expect(meeting.getByLabel('Caption position',{exact:true})).toHaveValue('custom');

    const overlayArrows=await meeting.locator('.select-box').evaluateAll(els=>els.map(el=>{const a=getComputedStyle(el,'::after');return {top:a.top,right:a.right,border:a.borderRightStyle,pointerEvents:a.pointerEvents}}));
    expect(overlayArrows).toEqual(Array(4).fill({top:'18px',right:'12px',border:'solid',pointerEvents:'none'}));
    const bounds=await meeting.locator('#everyvoice-caption-overlay').evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}});
    expect(bounds.left).toBeGreaterThanOrEqual(0);expect(bounds.right).toBeLessThanOrEqual(360);
    expect(bounds.top).toBeGreaterThanOrEqual(0);expect(bounds.bottom).toBeLessThanOrEqual(640);
    const narrowAxe=await new AxeBuilder({page:meeting}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(narrowAxe.violations).toEqual([]);
    await meeting.screenshot({path:'test-results/extension-overlay-narrow.png'});
    await meeting.emulateMedia({forcedColors:'active'});
    await expect(meeting.locator('#size')).toHaveCSS('appearance','auto');
    expect(await meeting.locator('.select-box').first().evaluate(el=>getComputedStyle(el,'::after').display)).toBe('none');
    await meeting.emulateMedia({forcedColors:'none'});
    await meeting.setViewportSize({width:1280,height:800});
    await meeting.evaluate(()=>history.pushState({},'', '/different-meeting'));
    await expect(meeting.locator('#status')).toHaveText('This tab is not the paired meeting.');
    await expect(meeting.locator('#original')).toBeEmpty();
    await expect(meeting.locator('#translated')).not.toContainText('नमस्ते सभी को');
    await meeting.evaluate(()=>history.back());
    await expect(meeting.locator('#translated')).toHaveText('नमस्ते सभी को');
    await fetch(`${base}/api/extension/revoke`,{method:'POST',headers,body:'{}'});
    await expect.poll(async()=>JSON.stringify(await tree())).toContain('revoked');
    await expect(meeting.locator('#translated')).not.toContainText('नमस्ते सभी को');
    await expect(meeting.locator('#original')).toBeEmpty();
    await popup.getByRole('button',{name:'Disconnect this browser'}).click();
    await expect(meeting.locator('#everyvoice-caption-overlay')).not.toBeAttached();
  } finally {await context?.close();await kit.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});

test('a live speech authentication error is explicit while the recorder remains in the call',async({page})=>{
  const kit=createApp({env:{MEETSTREAM_API_KEY:'browser-test-key'},database:':memory:'});
  kit.store.saveMeeting({id:'live-error',botId:'live-error-bot',liveToken:'callback-token',title:'Live error example',mode:'live',status:'live',postCallStatus:'pending',liveProvider:'jigsawstack_streaming',source:'auto',targets:['en'],createdAt:Date.now()});
  const server=kit.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    await page.goto(base+'/workspace?view=captions&meeting=live-error&panel=captions');
    await expect(page.getByRole('heading',{level:1})).toHaveText('Live error example');
    const response=await page.request.post(base+'/webhooks/callback/live-error/callback-token',{data:{bot_id:'live-error-bot',event:'bot.error',message:'JigsawStack authentication failed (HTTP 401).'}});
    expect(response.status()).toBe(202);
    await expect(page.locator('#stream-status')).toContainText('unavailable');
    await expect(page.locator('#caption-waiting')).toContainText('HTTP 401');
    await expect(page.locator('#caption-waiting')).not.toContainText('Waiting for speech');
    await page.getByRole('button',{name:'Connections',exact:true}).click();
    await expect(page.getByRole('article').filter({has:page.getByRole('heading',{name:'JigsawStack speech',exact:true})})).toContainText('authentication failed (HTTP 401)');
    const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(axe.violations).toEqual([]);
  } finally {await kit.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
