import{test,expect}from'@playwright/test';import AxeBuilder from'@axe-core/playwright';import{createApp}from'../../server/app.js';
test('recording workspace keeps playback beside bilingual transcript, changes language, and seeks audio',async({page})=>{
 const sampleRate=8000,pcm=Buffer.alloc(sampleRate*6*2),wav=Buffer.alloc(44+pcm.length);
 wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(sampleRate,24);wav.writeUInt32LE(sampleRate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);
 const kit=createApp({env:{},database:':memory:',startWorker:false,meetstream:{bots:{audio:async()=>({audio_url:'https://storage.amazonaws.com/fixture.wav'})}},fetchImpl:async(_url,opts)=>{const range=/^bytes=(\d+)-(\d*)/.exec(opts.headers?.Range||''),start=Number(range?.[1]||0),end=range?.[2] ? Math.min(Number(range[2]),wav.length-1) : wav.length-1,data=wav.subarray(start,end+1);return new Response(data,{status:206,headers:{'Content-Type':'audio/wav','Content-Length':String(data.length),'Content-Range':`bytes ${start}-${end}/${wav.length}`,'Accept-Ranges':'bytes'}})}});
 const id='recording-redesign';kit.store.saveMeeting({id,botId:'fixture-bot',title:'Design review · bilingual meeting',mode:'live',status:'completed',postCallStatus:'ready',createdAt:Date.now(),endedAt:Date.now(),targets:['en','hi'],source:'ta',translationProvider:'google',liveProvider:'deepgram_streaming'});
 kit.store.insertCue({id:'fixture-cue',meetingId:id,kind:'final',start:2,end:4,timing:'provider-relative',speaker:'Karthik',source:'ta',text:'வணக்கம்',receivedAt:Date.now(),translations:{en:{status:'ready',text:'Hello'},hi:{status:'ready',text:'नमस्ते'}}});
 const server=kit.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
 await page.goto(base+`/workspace?view=captions&meeting=${id}&panel=transcript&kind=final`);
 await expect(page.locator('#recording-panel')).toBeVisible();await expect(page.locator('#transcript-panel')).toBeVisible();await expect(page.locator('#audio-player')).toBeVisible();
 const left=await page.locator('#recording-panel').boundingBox(),right=await page.locator('#transcript-panel').boundingBox();expect(right.x).toBeGreaterThan(left.x+left.width);
 await page.getByLabel('Read in',{exact:true}).selectOption('hi');await expect(page.locator('.turn-translation')).toHaveText('नमस्ते');
 await page.getByRole('button',{name:'Seek recording to 00:02',exact:true}).click();await expect.poll(()=>page.locator('#audio-player').evaluate(el=>el.currentTime)).toBe(2);
 expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
 await page.screenshot({path:`test-results/meeting-workspace-${test.info().project.name}.png`,fullPage:true});
 await page.evaluate(()=>document.body.classList.add('high-contrast'));expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);await page.evaluate(()=>document.body.classList.remove('high-contrast'));
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 const notice=await page.locator('#toast').boundingBox(),navigation=await page.locator('.sidebar nav').boundingBox();if(notice){expect(notice.y+notice.height).toBeLessThanOrEqual(navigation.y);expect(notice.x).toBeGreaterThanOrEqual(0);expect(notice.x+notice.width).toBeLessThanOrEqual(360);}
 expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
 await page.screenshot({path:`test-results/meeting-workspace-mobile-${test.info().project.name}.png`,fullPage:true});
 await page.locator('#audio-player').evaluate(el=>el.play());await expect.poll(()=>page.locator('#audio-player').evaluate(el=>el.paused)).toBe(false);
 await page.getByRole('link',{name:'Back to meetings',exact:false}).click();await expect.poll(()=>page.locator('#audio-player').evaluate(el=>el.paused)).toBe(true);await expect(page.getByRole('link',{name:'Design review · bilingual meeting',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'List',exact:true}).click();await expect(page.locator('#library-list')).toHaveAttribute('aria-pressed','true');await page.reload();await expect(page.locator('#library-list')).toHaveAttribute('aria-pressed','true');
 await page.route('**/api/meetings?*',route=>route.fulfill({status:503,json:{error:'Fixture unavailable'}}));
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.locator('#library-error')).toContainText('Use Refresh to retry');
 await page.unroute('**/api/meetings?*');await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.locator('#library-error')).toBeHidden();
 await page.getByRole('button',{name:'Grid',exact:true}).click();await page.screenshot({path:`test-results/meeting-library-${test.info().project.name}.png`,fullPage:true});
 }finally{await kit.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
