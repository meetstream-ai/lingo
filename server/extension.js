import {meetingRoom} from '../extension/meeting-links.js';
export {meetingRoom} from '../extension/meeting-links.js';
import { translatedAudio } from './providers.js';
import { randomBytes } from 'node:crypto';
import { hash, meetingServices } from './core.js';
import { TRANSLATION_LANGUAGES } from './languages.js';

export function extensionRoutes(app, { store, authorize, env, addLanguage, fetchImpl, createMeeting, stopMeeting, switchSource, config }) {
  store.db.exec('CREATE TABLE IF NOT EXISTS extension_tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, meeting_id TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL)');
  const prune = () => store.db.prepare('DELETE FROM extension_tokens WHERE expires < ?').run(Date.now());
  const owner = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!env.APP_PASSWORD || !authorize(req)) return res.status(401).json({ error: 'Sign into a password-protected workspace first.' });
    const allowed = env.PUBLIC_ORIGIN || `http://${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== allowed && !(env.NODE_ENV !== 'production' && req.headers.origin === `http://${req.headers.host}`)) return res.status(403).json({ error: 'Request origin is not allowed.' });
    next();
  };
  app.post('/api/extension/authorize',owner,(_req,res)=>{
    prune();
    const code=randomBytes(32).toString('hex'),expires=Date.now()+300000;
    store.db.prepare('INSERT INTO extension_tokens VALUES (?,?,?,?,?)').run(hash(code),'workspace_pair','*',expires,Date.now());
    res.json({code,expires});
  });
  app.post('/api/extension/pairing', owner, (req, res) => {
    prune();
    const m = store.meeting(req.body?.meetingId);
    if (!m) return res.status(404).json({ error: 'Select a meeting to connect.' });
    const code = randomBytes(32).toString('hex'), expires = Date.now() + 300000;
    store.db.prepare("DELETE FROM extension_tokens WHERE kind='pair' AND meeting_id=?").run(m.id);
    store.db.prepare('INSERT INTO extension_tokens VALUES (?, ?, ?, ?, ?)').run(hash(code), 'pair', m.id, expires, Date.now());
    res.json({ code, expires, meetingTitle: m.title });
  });
  app.post('/api/extension/revoke', owner, (req, res) => {
    store.db.prepare('DELETE FROM extension_tokens').run();
    res.json({ revoked: true });
  });
  app.use('/extension-api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return res.status(403).json({ error: 'Use the Chrome extension to connect.' });
    // Host permission allows extension-worker requests. Never enable website CORS.
    next();
  });
  app.post('/extension-api/pair', (req, res) => {
    const code = req.body?.code;
    if (typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code)) return res.status(401).json({ error: 'Invalid or expired pairing code.' });
    prune();
    const grant = store.db.prepare("SELECT * FROM extension_tokens WHERE hash=? AND kind='pair'").get(hash(code));
    if (!grant || !store.meeting(grant.meeting_id)) return res.status(401).json({ error: 'Invalid or expired pairing code.' });
    const token = randomBytes(32).toString('hex'), expires = Date.now() + 86400000;
    store.transaction(() => {
      store.db.prepare('DELETE FROM extension_tokens WHERE hash=?').run(hash(code));
      store.db.prepare('INSERT INTO extension_tokens VALUES (?, ?, ?, ?, ?)').run(hash(token), 'access', grant.meeting_id, expires, Date.now());
    });
    res.json({ token, expires });
  });
  function mint(kind,meetingId,expires=Date.now()+86400000) {
    const token=randomBytes(32).toString('hex');
    store.db.prepare('INSERT INTO extension_tokens VALUES (?,?,?,?,?)').run(hash(token),kind,meetingId,expires,Date.now());
    return {token,expires};
  }
  app.post('/extension-api/connect', (req,res)=>{
    const code=req.body?.code;
    if(typeof code!=='string' || !/^[a-f0-9]{64}$/.test(code))return res.status(401).json({error:'Invalid workspace authorization.'});
    prune();
    const grant=store.db.prepare("SELECT * FROM extension_tokens WHERE hash=? AND kind='workspace_pair'").get(hash(code));
    if(!grant)return res.status(401).json({error:'Workspace authorization expired. Connect again.'});
    const result=store.transaction(()=>{store.db.prepare('DELETE FROM extension_tokens WHERE hash=?').run(hash(code));return mint('workspace_access','*');});
    res.json(result);
  });
  app.use('/extension-api/workspace',(req,res,next)=>{
    const token=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
    const grant=token && store.db.prepare("SELECT * FROM extension_tokens WHERE hash=? AND kind='workspace_access' AND expires>?").get(hash(token),Date.now());
    if(!grant)return res.status(401).json({error:'Workspace connection expired or was revoked. Connect again.'});
    req.workspaceGrant=grant;next();
  });
  const summary=m=>({id:m.id,title:m.title,meetingLink:m.meetingLink,mode:m.mode,status:m.status,targets:m.targets,createdAt:m.createdAt,services:meetingServices(m),endedAt:m.endedAt || null});
  app.get('/extension-api/workspace',(_req,res)=>res.json({config:config(),meetings:store.meetings().slice(0,50).map(summary)}));
  app.post('/extension-api/workspace/session',(req,res)=>{
    const m=store.meeting(req.body?.meetingId);
    if(!m)return res.status(404).json({error:'Meeting not found.'});
    res.json({...mint('access',m.id,req.workspaceGrant.expires),meeting:summary(m)});
  });
  // ponytail: one server process. A per-room promise prevents duplicate bots while preflight awaits.
  const starting=new Map();
  const sameRoom=(link,room)=>{try{return meetingRoom(link)===room;}catch{return false;}};
  app.post('/extension-api/workspace/meetings',async(req,res)=>{
    try {
      const room=meetingRoom(req.body?.meetingLink);
      let task=starting.get(room);
      if(!task){task=(async()=>{
        const existing=store.meetings().find(m=>m.mode==='live' && !m.endedAt && ['connecting','joining','waiting','live'].includes(m.status) && sameRoom(m.meetingLink,room));
        if(existing){addLanguage(existing,req.body?.targets?.[0]);return summary(existing);}
        return summary(await createMeeting({...req.body,mode:'live'}));
      })();starting.set(room,task);task.finally(()=>starting.delete(room)).catch(()=>{});}
      const meeting=await task;
      // Each concurrent caller can request its own target without creating another bot.
      addLanguage(store.meeting(meeting.id),req.body?.targets?.[0]);
      res.status(201).json({...mint('access',meeting.id,req.workspaceGrant.expires),meeting:summary(store.meeting(meeting.id))});
    }catch(e){res.status(e.status || 409).json({error:e.message});}
  });
  app.post('/extension-api/workspace/source',async(req,res)=>{
    const m=store.meeting(req.body?.meetingId);
    if(!m)return res.status(404).json({error:'Meeting not found.'});
    try {res.status(202).json(await switchSource(m,req.body?.source,req.body?.confirmed));}
    catch(e){res.status(e.status || 409).json({error:e.message});}
  });
  app.post('/extension-api/workspace/stop',(req,res)=>{
    const m=store.meeting(req.body?.meetingId);
    if(!m)return res.status(404).json({error:'Meeting not found.'});
    res.status(202).json(summary(stopMeeting(m)));
  });
  app.use('/extension-api', (req, res, next) => {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
    const grant = token && store.db.prepare("SELECT * FROM extension_tokens WHERE hash=? AND kind='access' AND expires>?").get(hash(token), Date.now());
    const m = grant && store.meeting(grant.meeting_id);
    if (!m) return res.status(401).json({ error: 'Extension connection expired or was revoked. Pair again in the workspace.' });
    req.extensionMeeting = m;
    next();
  });
  app.get('/extension-api/captions', (req, res) => {
    const m = req.extensionMeeting;
    const target = typeof req.query.target === 'string' ? req.query.target : m.targets[0];
    const cues = store.db.prepare("SELECT data FROM cues WHERE meeting_id=? AND kind='live' ORDER BY start DESC LIMIT 3").all(m.id).map(r => JSON.parse(r.data)).reverse().map(c => ({ id: c.id, speaker: c.speaker, text: c.text, source: c.source, target, translation: c.translations[target] || { status: 'unavailable' }, receivedAt: c.receivedAt }));
    res.json({ meeting: { id: m.id, title: m.title, meetingLink: m.meetingLink, mode: m.mode, status: m.status, services:meetingServices(m), source:m.source, liveProvider:m.liveProvider, postCallProvider:m.postCallProvider, nextMeetingId:m.nextMeetingId || null, languageSwitch:m.languageSwitch || null, endedAt: m.endedAt || null, targets: m.targets, lastError: m.lastError || null, liveError: m.liveError || null }, languages: TRANSLATION_LANGUAGES[m.translationProvider], cues, serverTime: Date.now() });
  });
  app.post('/extension-api/speech',async(req,res)=>{
    const m=req.extensionMeeting,cue=store.cue(req.body?.cueId),target=req.body?.target;
    if(!m.targets.includes(target) || cue?.meetingId!==m.id || cue.translations[target]?.status!=='ready')return res.status(409).json({error:'Choose a ready caption from this meeting.'});
    try{res.json(await translatedAudio(cue.translations[target].text,target,env,fetchImpl));}
    catch(e){res.status(502).json({error:[401,403].includes(e.status)?'Google Cloud speech is not enabled for this key. Configure speech access in the workspace, or use an installed device voice.':'Cloud speech is unavailable. Try a device voice or check Connections.'});}
  });
  app.post('/extension-api/language', (req, res) => {
    try {
      addLanguage(req.extensionMeeting, req.body?.target);
      res.json({ queued: true });
    } catch (e) { res.status(409).json({ error: e.message }); }
  });
}
