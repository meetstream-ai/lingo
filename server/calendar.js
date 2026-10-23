import {jsonRequest}from'./providers.js';import{meetingRoom}from'../extension/meeting-links.js';
export const calendarConfigured=env=>['CALENDAR_CLIENT_ID','CALENDAR_CLIENT_SECRET','CALENDAR_REFRESH_TOKEN','CALENDAR_ID'].every(k=>env[k]);
export async function calendarEvents(env,fetchImpl=fetch,at=Date.now(),probe=false){
 if(!calendarConfigured(env))throw Error('Configure Google Calendar read-only credentials first.');
 const auth=await jsonRequest('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:env.CALENDAR_CLIENT_ID,client_secret:env.CALENDAR_CLIENT_SECRET,refresh_token:env.CALENDAR_REFRESH_TOKEN}).toString()},fetchImpl);
 if(!auth.access_token)throw Error('Google did not return a Calendar access token.');
 const items=[];let pageToken;
 for(let page=0;page<(probe?1:5);page++){
  const query=new URLSearchParams({singleEvents:'true',orderBy:'startTime',maxResults:probe?'1':'250',timeMin:new Date(at-6*3600000).toISOString(),timeMax:new Date(at+6*3600000).toISOString(),fields:'items(id,summary,status,start,end,hangoutLink,conferenceData/entryPoints),nextPageToken',...(pageToken?{pageToken}:{})});
  const data=await jsonRequest(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.CALENDAR_ID)}/events?${query}`,{headers:{Authorization:`Bearer ${auth.access_token}`}},fetchImpl);
  if(!Array.isArray(data.items))throw Error('Calendar returned an invalid event list.');items.push(...data.items);pageToken=data.nextPageToken;if(!pageToken)break;
 }
 return items;
}
export async function calendarMeetingName(m,env,fetchImpl=fetch){
 const room=meetingRoom(m.meetingLink),items=await calendarEvents(env,fetchImpl,m.createdAt);
 const match=items.filter(e=>e.status!=='cancelled' && typeof e.summary==='string' && e.summary.trim() && [e.hangoutLink,...(e.conferenceData?.entryPoints || []).map(p=>p.uri)].some(link=>{try{return meetingRoom(link)===room;}catch{return false;}}))
 .sort((a,b)=>Math.abs(Date.parse(a.start?.dateTime || a.start?.date)-m.createdAt)-Math.abs(Date.parse(b.start?.dateTime || b.start?.date)-m.createdAt))[0];
 return match?{title:match.summary.trim().slice(0,100),eventId:match.id}:null;
}
