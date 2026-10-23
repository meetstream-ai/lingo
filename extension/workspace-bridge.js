// Runs in the extension's isolated world on the workspace tab only.
(() => {
  if (globalThis.everyVoiceWorkspaceBridge) return;
  globalThis.everyVoiceWorkspaceBridge=true;
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(message.type !== 'AUTHORIZE_WORKSPACE' || sender.id !== chrome.runtime.id) return;
    if(location.pathname !== '/workspace' && !location.pathname.startsWith('/workspace/')) {reply({error:'Open the workspace page and select a meeting first.'});return;}
    const meetingId=document.body.dataset.meetingId || new URL(location.href).searchParams.get('meeting');

    fetch(message.workspaceScope?'/api/extension/authorize':'/api/extension/pairing',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({meetingId})})
      .then(async response=>{const data=await response.json();reply(response.ok?{code:data.code}:{error:data.error});})
      .catch(()=>reply({error:'Cannot reach the workspace. Keep npm start running.'}));
    return true;
  });
})();
