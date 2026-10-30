import { hash } from './core.js';
import { jsonRequest, translate } from './providers.js';
// Selected source turns stay linked to timestamps; no decisions or tasks are invented.
export function summaryInput(cues) {
  const final = cues.filter(c => c.kind === 'final');
  return final.length ? final : cues.filter(c => c.kind === 'live');
}
export function summaryFingerprint(cues, target, kind) {
  return hash(JSON.stringify(["sentences-v1", target, kind, summaryInput(cues).map(c => [c.id,c.text,c.translations[target]])]));
}
export async function meetingSummary(cues, target, kind, m, env, fetchImpl) {
  const turns = summaryInput(cues);
  if (!turns.length) throw Error('This meeting has no transcript to summarize. Recover its saved recording first.');
  const fingerprint = summaryFingerprint(cues, target, kind);
  let points;
  if (kind === 'ai') {
    if (!env.JIGSAWSTACK_API_KEY) throw Error('Configure and test JigsawStack text in Connections to use AI summaries.');
    const text = turns.map(c => `${c.speaker}: ${c.text}`).join('\n');
    if (text.length > 300000) throw Error('This transcript exceeds the summary provider’s 300,000-character limit.');
    const data = await jsonRequest('https://api.jigsawstack.com/v1/ai/summary', { method:'POST', headers:{'Content-Type':'application/json','x-api-key':env.JIGSAWSTACK_API_KEY}, body:JSON.stringify({text,type:'points',max_points:6,max_characters:3500}) },fetchImpl);
    if (data.success !== true || !Array.isArray(data.summary) || !data.summary.length || data.summary.length > 6 || data.summary.some(s => typeof s !== 'string' || !s.trim() || s.length > 5000)) throw Error('The summary provider returned invalid points.');
    points = [];
    for (const point of data.summary) points.push({text:(await translate(point,'auto',target,m.translationProvider,env,fetchImpl)).text});
  } else {
    return excerptSummary(cues,target);
  }
  return {target,kind,points,fingerprint,generatedAt:Date.now(),sourceKind:turns[0].kind,turnCount:turns.length};
}

// Local post-call overview: no provider key, network request or extra usage charge.
export function excerptSummary(cues,target) {
  const turns=summaryInput(cues);
  if(!turns.length)throw Error('This meeting has no transcript to summarize.');
  let points;
  // Join same-speaker chunks before selecting complete sentences, so excerpts do not cut a thought mid-turn.
  const paragraphs=[];
  for(const c of turns) {
    const t=c.translations[target], text=c.source===target ? c.text : t?.status==='ready' ? t.text : null;
    if(!text)throw Error('Some translations are not ready in this language. Retry translations or choose another language.');
    let paragraph=paragraphs.at(-1);
    if(!paragraph || paragraph.speaker!==c.speaker){paragraph={speaker:c.speaker,text:'',offsets:[]};paragraphs.push(paragraph);}
    if(paragraph.text)paragraph.text+=' ';
    paragraph.offsets.push({offset:paragraph.text.length,start:c.start,cueId:c.id});paragraph.text+=text;
  }
  let segmenter;try{segmenter=new Intl.Segmenter(target,{granularity:'sentence'});}catch{segmenter=new Intl.Segmenter(undefined,{granularity:'sentence'});}
  const sentences=paragraphs.flatMap(p=>[...segmenter.segment(p.text)].map(s=>{
    const cue=p.offsets.findLast(c=>c.offset<=s.index);
    return {text:s.segment.trim(),speaker:p.speaker,start:cue.start,cueId:cue.cueId};
  })).filter(s=>s.text);
  const count=Math.min(6,sentences.length);
  points=Array.from({length:count},(_,i)=>sentences[count===1?0:Math.round(i*(sentences.length-1)/(count-1))]);
  return {target,kind:'excerpts',points,fingerprint:summaryFingerprint(cues,target,'excerpts'),generatedAt:Date.now(),sourceKind:turns[0].kind,turnCount:turns.length};
}
