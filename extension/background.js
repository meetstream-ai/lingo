import {meetingRoom} from './meeting-links.js';
// Only trusted extension pages can pair or change configuration. The meeting page
// can request captions from the paired origin; it cannot choose a URL or see a token.
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
function appOrigin(value) {
  const u = new URL(value);
  if (u.username || u.password || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname)))) throw Error('Use an HTTPS workspace URL, or localhost for development.');
  return u.origin;
}
function meetingTab(url, config, meeting) {
  try {
    if (meeting.mode === 'demo') return new URL(url).origin === config.origin;
    return meetingRoom(url) === meetingRoom(meeting.meetingLink);
  } catch {return false;}
}
function roomContext(url) {
  try {return {valid:true,room:meetingRoom(url)};}
  catch(e){return {valid:false,guidance:e.message};}
}
async function api(config, path, body) {
  const res = await fetch(`${config.origin}/extension-api/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}), 'ngrok-skip-browser-warning': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await res.json();
  if (!res.ok) throw Object.assign(Error(data.error || `Workspace returned HTTP ${res.status}.`), { status: res.status });
  return data;
}
async function handle(message, sender) {
  await storageReady;
  const internal = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
  if (!internal && !['FETCH','SELECT','SPEAK'].includes(message.type)) throw Error('Open the extension to change settings.');
  if(message.type==='OPEN_MEETING') {
    meetingRoom(message.url);
    const u=new URL(message.url);
    await chrome.tabs.create({url:u.href});return {ok:true};
  }
  if (message.type === 'QUICK_CONNECT') {
    const origin=appOrigin(message.origin);
    const tabs=await chrome.tabs.query({});
    const workspace=tabs.filter(tab=>{try {const u=new URL(tab.url);return u.origin===origin && (u.pathname==='/workspace' || u.pathname.startsWith('/workspace/'));}catch{return false;}}).sort((a,b)=>(b.lastAccessed || 0)-(a.lastAccessed || 0))[0];
    if(!workspace) throw Error('Open your workspace, sign in and select a meeting. Then click Connect open workspace.');
    await chrome.scripting.executeScript({target:{tabId:workspace.id},files:['workspace-bridge.js']});
    const grant=await chrome.tabs.sendMessage(workspace.id,{type:'AUTHORIZE_WORKSPACE',workspaceScope:true});
    if(!grant?.code) throw Error(grant?.error || 'Select a meeting in your workspace first.');
    const result=await api({origin},'connect',{code:grant.code});
    await chrome.storage.local.remove('config');
    await chrome.storage.session.remove('bindings');
    await Promise.allSettled(tabs.map(tab=>chrome.tabs.sendMessage(tab.id,{type:'STOP'})));
    await chrome.storage.local.set({workspace:{origin,...result}});
    return {connected:true};
  }
  if (message.type === 'PAIR') {
    const origin = appOrigin(message.origin);
    const result = await api({ origin }, 'pair', { code: message.code.trim() });
    const config = { origin, token: result.token, expires: result.expires, target: '' };
    const data = await api(config, 'captions');
    config.target = data.meeting.targets[0];
    await chrome.storage.local.set({ config });
    return { meeting: data.meeting, languages: data.languages, target: config.target };
  }
  const {workspace}=await chrome.storage.local.get('workspace');
  if(workspace && message.type!=='DISCONNECT') {
    if(Date.now()>=workspace.expires)throw Object.assign(Error('Workspace connection expired. Connect again.'),{status:401});
    const [active]=internal?await chrome.tabs.query({active:true,currentWindow:true}):[sender.tab];
    if(message.type==='ROOM'){const room=roomContext(message.url);return {...room,sameRoom:room.valid && meetingTab(active?.url,workspace,{mode:'live',meetingLink:message.url})};}
    const {bindings={}}=await chrome.storage.session.get('bindings');
    let binding=bindings[active?.id];
    async function captionsForBinding() {
      let data=await api(binding,`captions?target=${encodeURIComponent(binding.target)}`);
      if(!active?.url || !meetingTab(active.url,binding,data.meeting))throw Error('This tab is not the selected meeting.');
      for(let i=0;data.meeting.nextMeetingId && i<20;i++) {
        const next=await api(workspace,'workspace/session',{meetingId:data.meeting.nextMeetingId});
        if(!meetingTab(active.url,workspace,next.meeting))throw Error('The next recording belongs to another room.');
        binding={...binding,token:next.token,expires:next.expires,meetingId:next.meeting.id};
        bindings[active.id]=binding;await chrome.storage.session.set({bindings});
        data=await api(binding,`captions?target=${encodeURIComponent(binding.target)}`);
      }
      return data;
    }
    if(message.type==='CONFIG') {
      const data=await api(workspace,'workspace');
      let captions=null;
      if(binding){try{captions=await captionsForBinding();}catch{captions=null;}}
      return {...data,workspace:true,origin:workspace.origin,activeUrl:active?.url || '',activeRoom:roomContext(active?.url),...(captions?{...captions,target:binding.target}:{})};
    }
    if(message.type==='LAUNCH' || message.type==='SESSION') {
      if(!active?.id)throw Error('Open a meeting tab first.');
      if(message.type==='LAUNCH' && !meetingTab(active.url,workspace,{mode:'live',meetingLink:message.input?.meetingLink}))throw Error('Open the meeting URL in this tab before starting captions.');
      if(message.type==='LAUNCH' && (!message.input.title?.trim() || ['Meeting captions','Multilingual team sync'].includes(message.input.title))) {
        const [{result:title}]=await chrome.scripting.executeScript({target:{tabId:active.id},func:()=>document.title});
        const cleaned=String(title || '').replace(/^(?:Meet|Google Meet|Zoom|Microsoft Teams)\s*[-–|:]\s*/i,'').replace(/\s*[-–|:]\s*(?:Google Meet|Zoom|Microsoft Teams)$/i,'').trim();
        const useful=cleaned && !/^(?:meet|google meet|zoom|microsoft teams|meeting|[a-z]{3}-[a-z]{4}-[a-z]{3}|\d{9,11})$/i.test(cleaned);
        const u=new URL(message.input.meetingLink);
        message.input={...message.input,title:useful?cleaned.slice(0,100):`${u.hostname==='meet.google.com'?'Google Meet':u.hostname.includes('zoom.us')?'Zoom':'Teams'} · ${u.pathname.split('/').filter(Boolean).at(-1).slice(0,50)}`,autoTitle:true,titleSource:useful?'browser':'automatic'};
      }
      const result=await api(workspace,message.type==='LAUNCH'?'workspace/meetings':'workspace/session',message.type==='LAUNCH'?message.input:{meetingId:message.meetingId});
      if(!meetingTab(active.url,workspace,result.meeting))throw Error('Open this meeting’s browser tab, then choose it here.');
      binding={origin:workspace.origin,token:result.token,expires:result.expires,target:message.input?.targets?.[0] || result.meeting.targets[0],meetingId:result.meeting.id};
      bindings[active.id]=binding;await chrome.storage.session.set({bindings});
      await showOverlay(active.id);
      return {meeting:result.meeting};
    }
    if(message.type==='END') {
      if(!binding)throw Error('Start or select a meeting on this tab first.');
      const result=await api(workspace,'workspace/stop',{meetingId:binding.meetingId});
      return {meeting:result,origin:workspace.origin};
    }
    if(!binding)throw Object.assign(Error('Start or select captions for this meeting tab in the extension.'),{status:401});
    const data=await captionsForBinding();
    if(!active?.url || !meetingTab(active.url,binding,data.meeting))throw Object.assign(Error('This tab is not the selected meeting.'),{status:403});
    if(message.type==='CLEAR_SESSION'){
      if(!data.meeting.endedAt && !['completed','stopped','failed'].includes(data.meeting.status))throw Error('End the current recording before starting another session.');
      delete bindings[active.id];await chrome.storage.session.set({bindings});await chrome.tabs.sendMessage(active.id,{type:'STOP'}).catch(()=>{});return {ok:true};
    }
    if(message.type==='SOURCE')return api(workspace,'workspace/source',{meetingId:binding.meetingId,source:message.source,confirmed:true});
    if(message.type==='FETCH')return {...data,target:binding.target};
    if(message.type==='START'){await showOverlay(active.id);return {ok:true};}
    if(message.type==='SPEAK')return api(binding,'speech',{cueId:message.cueId,target:binding.target});
    if(message.type==='SELECT') {
      if(!internal && !data.meeting.targets.includes(message.target))throw Error('Choose a configured meeting language.');
      await api(binding,'language',{target:message.target});binding.target=message.target;bindings[active.id]=binding;
      await chrome.storage.session.set({bindings});return {ok:true};
    }
    throw Error('Unsupported extension action.');
  }
  const { config } = await chrome.storage.local.get('config');
  if (message.type === 'DISCONNECT') {
    await chrome.storage.local.remove(['config','workspace']);
    await chrome.storage.session.remove('bindings');
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: 'STOP' })));
    return { ok: true };
  }
  if (!config) throw Object.assign(Error('Connect a meeting first.'), { status: 401 });
  if (Date.now() >= config.expires) throw Object.assign(Error('Connection expired. Click Connect open workspace to reconnect.'), { status: 401 });
  if (!internal && ['SELECT','SPEAK'].includes(message.type)) {
    const current=await api(config,'captions');
    if (!sender.tab || !meetingTab(sender.tab.url,config,current.meeting)) throw Object.assign(Error('This tab is not the paired meeting.'),{status:403});
    if(message.type==='SELECT' && !current.meeting.targets.includes(message.target)) throw Error('Choose one of this meeting’s configured languages.');
  }
  if (message.type === 'SPEAK') return api(config,'speech',{cueId:message.cueId,target:config.target});
  if (message.type === 'SELECT') {
    await api(config, 'language', { target: message.target });
    config.target = message.target;
    await chrome.storage.local.set({ config });
    return { ok: true };
  }
  const data = await api(config, `captions?target=${encodeURIComponent(config.target)}`);
  if (message.type === 'CONFIG') return { ...data, target: config.target, origin: config.origin };
  if (message.type === 'FETCH') {
    if (!sender.tab || !meetingTab(sender.tab.url, config, data.meeting)) throw Object.assign(Error('This tab is not the paired meeting.'), { status: 403 });
    return { meeting: data.meeting, cues: data.cues, target: config.target, languages: data.languages };
  }
  if (message.type === 'START') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !meetingTab(tab.url, config, data.meeting)) throw Error('Open the paired meeting in this browser tab, then open the extension. For a sample, open the workspace tab.');
    try { await chrome.tabs.sendMessage(tab.id, { type: 'START' }); }
    catch { throw Error('Refresh the paired meeting tab once, then reopen the extension and show captions.'); }
    return { ok: true };
  }
  throw Error('Unsupported extension action.');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender).then(data => reply({ ok: true, data })).catch(error => reply({ ok: false, error: error.message || 'Connection failed. Check workspace availability.', status: error.status || null }));
  return true;
});

async function showOverlay(tabId) {
  await chrome.scripting.executeScript({target:{tabId},files:['content.js']});
  await chrome.tabs.sendMessage(tabId,{type:'START'});
}
chrome.tabs.onRemoved.addListener(async tabId=>{
  const {bindings={}}=await chrome.storage.session.get('bindings');delete bindings[tabId];await chrome.storage.session.set({bindings});
});
chrome.tabs.onUpdated.addListener(async(tabId,change,tab)=>{
  if(change.status!=='complete')return;
  const {bindings={}}=await chrome.storage.session.get('bindings'),binding=bindings[tabId];
  if(!binding)return;
  try{const data=await api(binding,'captions');if(meetingTab(tab.url,binding,data.meeting))await showOverlay(tabId);else{delete bindings[tabId];await chrome.storage.session.set({bindings});}}
  catch{/* Reconnection errors are shown when the user opens the extension. */}
});
