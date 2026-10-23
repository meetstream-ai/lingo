(() => {
  if(globalThis.everyVoiceCaptionsInstalled)return;
  globalThis.everyVoiceCaptionsInstalled=true;
  let host, root, timer, paused = false, lastId = null, connectionStatus = "";
  const preferences = { size: "26", position: "bottom", original: true, width: "680", x: null, y: null };
  const status = message => {
    connectionStatus = message;
    const element = root.querySelector("#status"), text = `${paused ? "Paused · " : ""}${message}`;
    if (element.textContent !== text) element.textContent = text;
  };
  let reading=false, currentCaption=null, spokenAudio=null, spokenUrl=null, speechEpoch=0;
  const stopSpeech=()=>{speechEpoch++;spokenAudio?.pause();if(spokenUrl)URL.revokeObjectURL(spokenUrl);spokenAudio=null;spokenUrl=null;speechSynthesis?.cancel();reading=false;root?.querySelector("#listen")?.setAttribute("aria-pressed","false");};
  const close = () => { stopSpeech(); clearTimeout(timer); host?.remove(); host = null; lastId = null; };
  async function poll() {
    if (!host) return;
    const currentHost = host;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'FETCH' });
      if (host !== currentHost) return;
      if (!result?.ok) throw Object.assign(Error(result?.error || 'Workspace disconnected.'), { status: result?.status });
      const { meeting, cues, target, languages } = result.data;
      root.querySelector('#providers').textContent=meeting.services?`Speech: ${meeting.services.speech} · Translation: ${meeting.services.translation}`:'';
      const language=root.querySelector('#language');
      if([...language.options].map(o=>o.value).join() !== meeting.targets.join()) language.replaceChildren(...meeting.targets.map(code=>new Option(languages[code] || code,code)));
      language.value=target;
      const cue = cues.at(-1);
      status(meeting.liveError || meeting.lastError ? `Provider error: ${meeting.liveError || meeting.lastError}` : meeting.mode === 'demo' ? 'Sample · handwritten translations' : meeting.endedAt ? 'Meeting ended · captions saved' : cue ? 'Live translated captions' : meeting.status === 'live' ? 'Waiting for speech · bot connected' : 'Waiting for speech · admit the meeting bot');
      if (!paused) {
        if (cue) {
          root.querySelector('#speaker').textContent = cue.speaker;
          const original = root.querySelector('#original'), translated = root.querySelector('#translated');
          original.textContent = cue.text; original.lang = cue.source || 'und';
          translated.textContent = cue.translation.status === 'ready' ? cue.translation.text : cue.translation.status === 'failed' ? 'Translation failed. Check the workspace for details.' : 'Translating…'; translated.lang = target;
          currentCaption=cue.translation.status === 'ready' ? {id:cue.id,text:cue.translation.text,lang:target} : null;
          root.querySelector('#listen').disabled=!currentCaption;
          const key = `${cue.id}:${target}:${cue.translation.status}`;
          if (key !== lastId) { root.querySelector('#announce').textContent = `${cue.speaker}: ${translated.textContent}`; lastId = key; }
        }
      }
    } catch(e) {
      if (host === currentHost) {
        if ([401, 403].includes(e.status)) {
          root.querySelector('#speaker').textContent = 'Lingo';
          root.querySelector('#original').textContent = '';
          root.querySelector('#translated').textContent = 'Connect this meeting again in the extension.';
          root.querySelector('#announce').textContent = '';
          lastId = null; currentCaption=null; stopSpeech();
          root.querySelector('#listen').disabled=true;
          status(e.message);
        } else status(lastId ? 'Connection interrupted · showing the last caption. Retrying…' : 'Cannot reach the workspace. Retrying…');
      }
    }
    if (host === currentHost) timer = setTimeout(poll, 1500);
  }
  function show() {
    if (host) return;
    host = document.createElement('div'); host.id = 'everyvoice-caption-overlay';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{all:initial;position:fixed;left:50%;bottom:90px;transform:translateX(-50%);width:min(680px,calc(100vw - 32px));z-index:2147483647;font:14px/1.4 Aptos,"Segoe UI",system-ui,sans-serif;color:white;color-scheme:dark}
      *{box-sizing:border-box}
      .panel{background:#131a29f2;border:1px solid #748097;border-radius:12px;padding:14px 18px;backdrop-filter:blur(12px);box-shadow:0 8px 30px #0005;max-height:calc(100dvh - 140px);overflow:auto}
      .top{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;align-items:center;gap:8px}
      #speaker{min-width:0;overflow-wrap:anywhere}
      .controls{display:grid;grid-template-columns:minmax(100px,1fr) minmax(100px,1fr) auto auto;align-items:end;gap:8px;margin-top:12px}
      label{display:grid;gap:6px;font-size:12px;line-height:16px;min-width:0}
      button,select{font:13px/20px Aptos,"Segoe UI",system-ui,sans-serif;background:#263246;color:white;border:1px solid #8ea1c4;border-radius:5px;padding:7px 10px;height:36px;min-width:0;margin:0;cursor:pointer}
      select{width:100%;appearance:none;padding-right:34px}
      .select-box{position:relative;display:block;min-width:0;line-height:0}
      .select-box::after{content:"";position:absolute;right:12px;top:50%;width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(-65%) rotate(45deg);pointer-events:none}
      button:focus-visible,select:focus-visible{outline:3px solid white;outline-offset:2px}
      button[aria-pressed=true]{background:#3b5078}
      p{margin:14px 0 0;overflow-wrap:anywhere}
      #original{color:#d0daf0;font-size:16px}
      #translated{font-size:26px;font-weight:600;line-height:1.35}
      #providers{color:#d5e1fa;font-size:13px;font-weight:600;margin:8px 0}#status{color:#c8d5ee;font-size:12px}
      .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
      [hidden]{display:none!important}
      @media(max-width:480px){.panel{padding:12px}.controls{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}#translated{font-size:22px}}
      #move{cursor:grab;touch-action:none}
      @media(max-width:380px){.top{grid-template-columns:minmax(0,1fr) auto auto}#speaker{grid-column:1 / -1}}
      @media(max-width:280px){.controls{grid-template-columns:minmax(0,1fr)}}
      @media(forced-colors:active){select{appearance:auto}.select-box::after{display:none}}
    </style>
    <section class="panel" aria-label="Lingo meeting captions">
      <div class="top"><strong id="speaker" dir="auto">Lingo</strong><button id="move" aria-label="Move captions with arrow keys or drag" title="Drag to move, or use arrow keys">Move</button><button id="settings" aria-expanded="false" aria-controls="settings-controls">Settings</button><button id="close" aria-label="Close caption overlay">Close</button></div>
      <div class="controls" id="settings-controls" hidden>
        <label>Size<span class="select-box"><select id="size" aria-label="Caption text size"><option value="22">Small</option><option value="26" selected>Medium</option><option value="34">Large</option></select></span></label>
        <label>Position<span class="select-box"><select id="position" aria-label="Caption position"><option value="bottom">Bottom</option><option value="top">Top</option><option value="left">Left</option><option value="right">Right</option><option value="custom">Custom · drag to move</option></select></span></label>
        <button id="pause" aria-pressed="false">Pause</button><button id="original-toggle" aria-pressed="true">Original</button>
        <label>Language<span class="select-box"><select id="language" aria-label="Caption language"></select></span></label><label>Width<span class="select-box"><select id="width" aria-label="Caption panel width"><option value="460">Compact</option><option value="680" selected>Comfortable</option><option value="900">Wide</option></select></span></label><button id="listen" aria-pressed="false" disabled>Listen</button>
      </div>
      <p id="providers"></p><p id="original" dir="auto"></p><p id="translated" dir="auto">Waiting for captions…</p><p id="status" role="status">Connecting to your workspace…</p><div id="announce" class="sr" aria-live="polite" aria-atomic="true"></div>
    </section>`;
    const style = root.querySelector('style');
    const sheet = new CSSStyleSheet(); sheet.replaceSync(style.textContent);
    root.adoptedStyleSheets = [sheet]; style.remove();
    (document.fullscreenElement || document.body).append(host);
    paused = false;
    connectionStatus = "Connecting to your workspace…";
    root.querySelector('#close').onclick = close;
    root.querySelector('#settings').onclick=event=>{const controls=root.querySelector('#settings-controls');controls.hidden=!controls.hidden;event.target.setAttribute('aria-expanded',String(!controls.hidden));requestAnimationFrame(position);};
    root.querySelector('#language').onchange=async event=>{stopSpeech();try {const result=await chrome.runtime.sendMessage({type:'SELECT',target:event.target.value});if(!result?.ok)throw Error(result?.error || 'Language selection failed.');lastId=null;currentCaption=null;}catch(e){status(e.message);}};
    root.querySelector('#listen').onclick=async()=>{
      if(reading){stopSpeech();return;} if(!currentCaption)return;
      const caption={...currentCaption},epoch=++speechEpoch,button=root.querySelector('#listen');button.disabled=true;
      try {
        const result=await chrome.runtime.sendMessage({type:'SPEAK',cueId:caption.id});
        if(epoch!==speechEpoch || !host)return;
        if(!result?.ok)throw Error(result?.error || 'Cloud speech is unavailable.');
        const data=result.data,bytes=Uint8Array.from(atob(data.audioContent),c=>c.charCodeAt(0));spokenUrl=URL.createObjectURL(new Blob([bytes],{type:data.type}));spokenAudio=new Audio(spokenUrl);reading=true;button.setAttribute('aria-pressed','true');spokenAudio.onended=stopSpeech;spokenAudio.onerror=()=>{stopSpeech();status('Audio playback was blocked. Use a device voice or the workspace transcript.');};await spokenAudio.play();
      }catch(e){
        if(epoch!==speechEpoch || !host)return;
        spokenAudio?.pause();if(spokenUrl)URL.revokeObjectURL(spokenUrl);spokenAudio=null;spokenUrl=null;reading=false;button.setAttribute('aria-pressed','false');
        const voice=speechSynthesis.getVoices().find(v=>v.lang.split('-')[0].toLowerCase()===caption.lang.split('-')[0].toLowerCase());
        if(!voice){status(`${e.message} No ${caption.lang} device voice is installed.`);return;}
        const utterance=new SpeechSynthesisUtterance(caption.text);utterance.voice=voice;utterance.lang=voice.lang;
        reading=true;button.setAttribute('aria-pressed','true');utterance.onend=stopSpeech;utterance.onerror=()=>{stopSpeech();status('Read-aloud failed. Check your device speech voice.');};speechSynthesis.speak(utterance);
      }finally{button.disabled=!currentCaption;}
    };
    root.querySelector('#pause').onclick = event => { paused = !paused; if(paused)stopSpeech(); event.target.textContent = paused ? 'Resume' : 'Pause'; event.target.setAttribute('aria-pressed',String(paused)); root.querySelector('#announce').textContent = ''; status(connectionStatus); };
    root.querySelector('#size').value = preferences.size;
    root.querySelector('#translated').style.fontSize = `${preferences.size}px`;
    root.querySelector('#size').onchange = event => { preferences.size = event.target.value; root.querySelector('#translated').style.fontSize = `${preferences.size}px`; };
    const position = () => {
      if(!host)return;
      host.style.width=`min(${preferences.width}px,calc(100vw - 32px))`;
      host.style.transform='none';host.style.bottom='auto';
      host.style.left='';host.style.right='';host.style.top='';host.style.bottom='';
      if(preferences.position==='custom') {
        const rect=host.getBoundingClientRect();
        host.style.left=`clamp(8px,${preferences.x ?? 16}px,calc(100vw - min(${preferences.width}px,calc(100vw - 32px)) - 8px))`;
        host.style.top=`clamp(8px,${preferences.y ?? 24}px,calc(100dvh - ${rect.height}px - 8px))`;
      } else if(preferences.position==='left'||preferences.position==='right') {
        host.style[preferences.position]='16px';host.style.top='50%';host.style.transform='translateY(-50%)';
      } else {
        host.style.left='50%';host.style.transform='translateX(-50%)';
        if(preferences.position==='top')host.style.top='24px';else host.style.bottom='90px';
      }
    };
    root.querySelector('#position').value=preferences.position;position();
    root.querySelector('#position').onchange=event=>{preferences.position=event.target.value;position();};
    root.querySelector('#width').value=preferences.width;
    root.querySelector('#width').onchange=event=>{preferences.width=event.target.value;position();};
    const move=root.querySelector('#move');let drag;
    const custom=(x,y)=>{preferences.position='custom';preferences.x=x;preferences.y=y;root.querySelector('#position').value='custom';position();};
    move.onpointerdown=e=>{const r=host.getBoundingClientRect();drag={x:e.clientX-r.left,y:e.clientY-r.top};move.setPointerCapture(e.pointerId);};
    move.onpointermove=e=>{if(drag)custom(e.clientX-drag.x,e.clientY-drag.y);};
    move.onpointerup=move.onpointercancel=()=>{drag=null;};
    move.onkeydown=e=>{const delta={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,-10],ArrowDown:[0,10]}[e.key];if(!delta)return;e.preventDefault();const r=host.getBoundingClientRect();custom(r.left+delta[0],r.top+delta[1]);};
    const resize=()=>{if(host)position();else window.removeEventListener('resize',resize);};window.addEventListener('resize',resize);
    root.querySelector('#original').hidden = !preferences.original;
    root.querySelector('#original-toggle').setAttribute('aria-pressed', String(preferences.original));
    root.querySelector('#original-toggle').onclick = event => { preferences.original = !preferences.original; root.querySelector('#original').hidden = !preferences.original; event.target.setAttribute('aria-pressed',String(preferences.original)); };
    poll();
  }
  chrome.runtime.onMessage.addListener(message => { if (message.type === 'START') show(); if (message.type === 'STOP') close(); });
  document.addEventListener('fullscreenchange', () => { if (host) (document.fullscreenElement || document.body).append(host); });
  window.addEventListener('pagehide', close);
})();
