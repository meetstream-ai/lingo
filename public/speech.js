// Speech is opt-in. Match the requested language; never substitute an unrelated voice.
(() => {
  let active = null, generation=0;
  const engine = window.speechSynthesis;
  const voiceFor = lang => engine?.getVoices().find(v => v.lang.toLowerCase() === lang.toLowerCase()) || engine?.getVoices().find(v => v.lang.split('-')[0].toLowerCase() === lang.split('-')[0].toLowerCase());
  function stop() { generation++;const previous=active;active=null;previous?.setAttribute('aria-pressed','false');engine?.cancel(); }
  async function speak(text, lang, button) {
    if (active === button) {stop();return;}
    stop();const current=generation;
    if (!engine || typeof SpeechSynthesisUtterance === 'undefined') throw Error('Read-aloud is not available in this browser.');
    let voice=voiceFor(lang);
    if(!voice) { await new Promise(resolve=>{const done=()=>{clearTimeout(timer);engine.removeEventListener('voiceschanged',done);resolve();};const timer=setTimeout(done,1200);engine.addEventListener('voiceschanged',done);});voice=voiceFor(lang); }
    if(current!==generation)return;
    if(!voice) throw Error(`No ${lang} voice is installed. Add a matching speech voice in your device settings, or use cloud audio once configured.`);
    const utterance=new SpeechSynthesisUtterance(text);utterance.lang=voice.lang;utterance.voice=voice;utterance.rate=1;
    active=button;button?.setAttribute('aria-pressed','true');
    utterance.onend=()=>{if(active===button && current===generation)stop();};utterance.onerror=event=>{if(active===button && current===generation)stop();if(!['canceled','interrupted'].includes(event.error)) document.dispatchEvent(new CustomEvent('speech-error',{detail:'Read-aloud failed. Check the installed voice and try again.'}));};
    engine.speak(utterance);
  }
  window.LingoSpeech={speak,stop};
  window.addEventListener('pagehide',stop);
})();
