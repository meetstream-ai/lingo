// One parser for bot invitations, extension tabs and calendar matching.
function roomDetails(value) {
  let url;
  try {url=new URL(value);}catch {throw Error('Enter a full Google Meet, Zoom or Teams meeting invitation URL.');}
  if(url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443'))throw Error('Use an HTTPS meeting invitation without embedded account credentials or a custom port.');
  if(url.hostname==='meet.google.com') {
    const match=/^\/(?:meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i.exec(url.pathname);
    if(match){url.pathname='/'+match[1].toLowerCase();return {url,key:`meet.google.com${url.pathname}`};}
    throw Error('Join a Google Meet call first, then open Lingo on that call tab. Use its invitation, such as https://meet.google.com/abc-defg-hij; the Meet homepage is not a call.');
  }
  if(url.hostname==='zoom.us' || url.hostname.endsWith('.zoom.us')) {
    const match=/^\/(?:[jsw]\/(\d{9,11})|wc\/(\d{9,11})(?:\/(?:join|start))?|wc\/join\/(\d{9,11}))\/?$/.exec(url.pathname);
    if(match){const id=match[1] || match[2] || match[3];url.pathname='/j/'+id;return {url,key:`zoom:${id}`};}
    throw Error('Use a Zoom invitation with its numeric meeting ID, or open its web call. For a personal /my/ link, join it first and copy the numeric meeting invitation from meeting details.');
  }
  if(['teams.microsoft.com','teams.cloud.microsoft','teams.live.com'].includes(url.hostname)) {
    const family=url.hostname==='teams.live.com'?'teams.live.com':'teams.microsoft.com';
    const modern=/^\/meet\/(\d{8,20})\/?$/.exec(url.pathname);
    const legacy=/^\/l\/meetup-join\/([^/]+)(?:\/\d+)?\/?$/.exec(url.pathname);
    let thread;
    try {thread=legacy && decodeURIComponent(legacy[1]);}catch {}
    if(modern || (thread?.startsWith('19:') && !/[\s\u0000-\u001f/?#\\]/.test(thread))) {
      const identity=modern?`/meet/${modern[1]}`:`/l/meetup-join/${thread}`;
      // Keep passcodes/context on the invitation; tracking/query order is not room identity.
      url.hostname=family;url.pathname=modern?identity:`/l/meetup-join/${encodeURIComponent(thread)}/0`;
      return {url,key:family+identity};
    }
    throw Error('Copy the Teams meeting invitation from its calendar event or meeting details. The Teams homepage, chat and generic app URL do not identify a meeting room.');
  }
  throw Error('Use a Google Meet, Zoom or Teams meeting invitation from your host or calendar.');
}
export function meetingRoom(value) {return roomDetails(value).key;}
export function meetingInvitation(value) {return roomDetails(value).url.href;}
