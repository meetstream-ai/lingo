const $ = id => document.getElementById(id);
$('extension-version').textContent=`Meeting captions · v${chrome.runtime.getManifest().version}`;
async function message(type, values = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...values });
  if (!result?.ok) throw Error(result?.error || 'Extension could not connect.');
  return result.data;
}
function error(e) { $('error').textContent = e?.message || ''; $('error').hidden = !e; }
async function refresh() {
  const data = await message('CONFIG');
  if(data.workspace){renderWorkspace(data);return;}
  $('pair-form').hidden = true; $('connected').hidden = false;
  $('meeting-title').textContent = data.meeting.title;
  $('meeting-status').textContent = data.meeting.services?`Speech: ${data.meeting.services.speech} · Translation: ${data.meeting.services.translation}`:data.meeting.mode === 'demo' ? 'Sample · handwritten captions' : `${data.meeting.status}${data.meeting.endedAt ? ' · meeting ended' : ''}`;
  $('language').replaceChildren(...Object.entries(data.languages).sort((a,b)=>a[1].localeCompare(b[1])).map(([code,name])=>new Option(name,code)));
  $('language').value = data.target;
  $('open-meeting').hidden = data.meeting.mode === 'demo';
  if (data.meeting.mode !== 'demo') $('open-meeting').href = data.meeting.meetingLink;
  $('open-workspace').href = `${data.origin}/workspace?view=captions&meeting=${encodeURIComponent(data.meeting.id)}&panel=captions`;
}
$('pair-form').addEventListener('submit', async e => {
  e.preventDefault(); error(); $('connect').disabled = true;
  try {
    const u = new URL($('workspace').value);
    if (u.protocol === 'https:') {
      const granted = await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
      if (!granted) throw Error('Allow access to your workspace to fetch captions.');
    }
    await message('PAIR', { origin: u.origin, code: $('code').value });
    $('code').value = ''; await refresh(); $('status').textContent = 'Meeting connected. Open its tab to show captions.';
  } catch(e) { error(e); } finally { $('connect').disabled = false; }
});
$('language').addEventListener('change', async () => {
  error(); $('language').disabled = true;
  try { await message('SELECT', { target: $('language').value }); $('status').textContent = 'Caption language updated.'; }
  catch(e) { error(e); await refresh().catch(()=>{}); } finally { $('language').disabled = false; }
});
$('show').addEventListener('click', async () => { error(); $('show').disabled = true; try { await message('START'); $('status').textContent = 'Caption overlay is open. You can close this popup.'; } catch(e) { error(e); } finally { $('show').disabled = false; } });
$('disconnect').addEventListener('click', async () => { try { await message('DISCONNECT'); $('pair-form').hidden = false; $('connected').hidden = true; $('workspace-connected').hidden=true; $('status').textContent = 'Browser disconnected.'; error(); } catch(e) { error(e); } });
refresh().catch(e => { if (!e.message.includes('Connect a meeting first')) error(e); });

$('quick-connect').addEventListener('click',async()=>{
  error();$('quick-connect').disabled=true;
  try {const u=new URL($('workspace').value);if(u.protocol==='https:'){if(!await chrome.permissions.request({origins:[`${u.protocol}//${u.hostname}/*`]}))throw Error('Allow access to this workspace to connect.');}
    await message('QUICK_CONNECT',{origin:u.origin});await refresh();$('status').textContent='Connected without copying a code. Open your meeting tab to show captions.';
  }catch(e){error(e);}finally{$('quick-connect').disabled=false;}
});

let workspaceData;
const options=(select,values,value)=>{select.replaceChildren(...Object.entries(values).sort((a,b)=>a[1].localeCompare(b[1])).map(([code,name])=>new Option(name,code)));if(value && Object.hasOwn(values,value))select.value=value;};
function renderWorkspace(data) {
  workspaceData=data;$('pair-form').hidden=true;$('connected').hidden=true;$('workspace-connected').hidden=false;
  $('workspace-home').href=`${data.origin}/workspace?view=sessions`;
  $('connections-link').href=`${data.origin}/workspace?view=settings`;
  $('meeting-url').value=data.activeRoom?.valid?data.activeUrl:'';
  $('room-status').textContent=data.config.liveReady?'Choose your language, then admit the meeting bot.':'Open Connections to configure MeetStream and a public HTTPS callback URL.';
  const providers=Object.fromEntries(Object.entries(data.config.providers).filter(([code,ready])=>ready && data.config.translationChecks?.[code]?.status!=='failed').map(([code])=>[code,({google:'Google Translate',azure:'Microsoft Translator',jigsawstack:'JigsawStack',deepl:'DeepL'})[code]]));
  options($('translation-provider'),providers,providers.google?'google':null);
  for(const option of $('speech-provider').options){const check=data.config.checks[option.value];option.disabled=check?.status==='failed';}
  if($('speech-provider').selectedOptions[0]?.disabled)$('speech-provider').value='meetstream';
  updateSources();updateTargets();
  workspaceData.launchReady=data.config.liveReady && !!Object.keys(providers).length;
  void updateRoom();
  const current=data.meeting;
  $('launch-form').hidden=!!current;$('current-session').hidden=!current;
  if(current){$('session-providers').textContent=current.services?`Speech: ${current.services.speech} · Translation: ${current.services.translation}`:'';$('session-source').textContent=`Spoken language: ${current.services?.source || 'Unknown'}`;$('session-source-help').textContent=current.services?.sourceHelp || '';$('session-title').textContent=current.title;$('session-status').textContent=current.liveError || current.lastError || current.status;
    options($('session-language'),data.languages,data.target);
    const link=`${data.origin}/workspace?view=captions&meeting=${encodeURIComponent(current.id)}`;
    $('session-transcript').href=`${link}&panel=captions`;$('session-summary').href=`${link}&panel=summary`;
    $('end-meeting').disabled=!!current.endedAt || ['completed','stopped','failed','stopping'].includes(current.status);$('new-session').hidden=!current.endedAt && !['completed','stopped','failed'].includes(current.status);renderSourceSwitch(current,data.config);
  }
  $('recent-meetings').replaceChildren(...data.meetings.slice(0,10).map(m=>{const row=document.createElement('div');row.className='recent-row';const link=document.createElement('a');link.textContent=m.title;link.href=`${data.origin}/workspace?view=captions&meeting=${encodeURIComponent(m.id)}&panel=summary`;link.target='_blank';link.rel='noreferrer';const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='Use on this tab';button.addEventListener('click',()=>action(button,async()=>{await message('SESSION',{meetingId:m.id});await refresh();}));row.append(link,button);return row;}));
}
function updateTargets(){if(workspaceData)options($('caption-target'),workspaceData.config.translationLanguages[$('translation-provider').value] || {},'hi');}
async function action(button,fn){error();button.disabled=true;try{await fn();}catch(e){error(e);}finally{button.disabled=false;}}
$('translation-provider').addEventListener('change',updateTargets);
$('launch-form').addEventListener('submit',e=>{e.preventDefault();action($('launch'),async()=>{
  const provider=$('speech-provider').value;
  await message('LAUNCH',{input:{title:$('call-title').value,meetingLink:$('meeting-url').value,source:$('source').value,targets:[$('caption-target').value],translationProvider:$('translation-provider').value,liveProvider:`${provider}_streaming`,postCallProvider:provider}});
  await refresh();$('status').textContent='Bot requested. Admit it in the meeting to receive captions.';
});});
$('session-show').addEventListener('click',()=>action($('session-show'),()=>message('START')));
$('session-language').addEventListener('change',()=>action($('session-language'),async()=>{await message('SELECT',{target:$('session-language').value});await refresh();}));
$('end-meeting').addEventListener('click',()=>action($('end-meeting'),async()=>{const data=await message('END');await chrome.tabs.create({url:`${data.origin}/workspace?view=captions&meeting=${encodeURIComponent(data.meeting.id)}&panel=summary`});await refresh();}));
$('workspace-disconnect').addEventListener('click',()=>$('disconnect').click());

function updateSources(){if(!workspaceData)return;const previous=$('source').value;const provider=$('speech-provider').value;const values=provider==='meetstream'?{auto:'Detect automatically',...workspaceData.config.languages}:provider==='jigsawstack'?{auto:'Detect automatically',...workspaceData.config.speechLanguages[provider]}:workspaceData.config.speechLanguages[provider];options($('source'),values,previous || 'en');}
$('speech-provider').addEventListener('change',updateSources);

$('new-session').addEventListener('click',()=>action($('new-session'),async()=>{await message('CLEAR_SESSION');await refresh();}));
setInterval(async()=>{
  if(!workspaceData?.meeting)return;
  try{const data=await message('CONFIG');if(data.meeting?.id!==workspaceData.meeting.id){if(data.meeting)renderWorkspace(data);return;}
    workspaceData.meeting=data.meeting;
    $('session-status').textContent=data.meeting.liveError || data.meeting.lastError || data.meeting.status;
    $('end-meeting').disabled=!!data.meeting.endedAt || ['completed','stopped','failed','stopping'].includes(data.meeting.status);
    $('new-session').hidden=!data.meeting.endedAt && !['completed','stopped','failed'].includes(data.meeting.status);renderSourceSwitch(data.meeting,data.config);
  }catch(e){error(e);}
},3000);

$('join-meeting').addEventListener('click',()=>action($('join-meeting'),async()=>{await message('OPEN_MEETING',{url:$('meeting-url').value});$('status').textContent='Join the meeting, then open this extension there to start captions.';}));

function renderSourceSwitch(meeting,config) {
  const provider=meeting.liveProvider?.replace('_streaming','');
  const values=provider==='meetstream'?{auto:'Detect automatically',...config.languages}:provider==='jigsawstack'?{auto:'Detect automatically',...config.speechLanguages[provider]}:config.speechLanguages[provider] || {};
  const filtered=Object.fromEntries(Object.entries(values).filter(([c])=>c!==meeting.source && (['meetstream','jigsawstack'].includes(meeting.postCallProvider) || Object.hasOwn(config.speechLanguages[meeting.postCallProvider] || {},c))));
  const select=$('switch-source');if([...select.options].map(o=>o.value).join()!==Object.keys(filtered).sort((a,b)=>filtered[a].localeCompare(filtered[b])).join())options(select,filtered,select.value);
  select.disabled=$('switch-source-save').disabled=!meeting.services?.canRestartSource || !select.options.length;
  if(!select.options.length)$('session-source-help').textContent='This provider combination supports no other spoken language. Start another recording with a different speech provider.';
  if(meeting.languageSwitch)$('session-status').textContent=meeting.languageSwitch.cancelled?'Language switch cancelled':meeting.languageSwitch.status==='failed'?`Language switch failed: ${meeting.lastError || 'Open workspace for details.'}`:`Changing spoken language · ${meeting.languageSwitch.status}`;
}
$('switch-source-form').addEventListener('submit',e=>{e.preventDefault();action($('switch-source-save'),async()=>{await message('SOURCE',{source:$('switch-source').value});await refresh();$('status').textContent='Switch requested. Captions resume when the bot rejoins.';});});

let roomEpoch=0;
async function updateRoom(){
  if(!workspaceData)return;
  const epoch=++roomEpoch;$('launch').disabled=true;$('join-meeting').disabled=true;
  try {
    const room=await message('ROOM',{url:$('meeting-url').value});if(epoch!==roomEpoch)return;
    $('join-meeting').disabled=!room.valid;
    $('launch').disabled=!room.sameRoom || !workspaceData.launchReady;
    $('room-status').textContent=!workspaceData.launchReady?'Open Connections to configure and test your speech and translation providers.':room.sameRoom?'Choose your languages and start captions. Admit the bot when it arrives.':room.valid?'Open this meeting in a new tab, join the call, then open Lingo on that tab to start captions.':'Join a meeting first, then open Lingo on that call tab. Or paste the meeting invitation below and choose Open meeting in a new tab.';
  }catch(e){if(epoch===roomEpoch)error(e);}
}
$('meeting-url').addEventListener('input',updateRoom);
