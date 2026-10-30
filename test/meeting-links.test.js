import test from 'node:test';import assert from 'node:assert/strict';
import {meetingRoom,meetingInvitation} from '../extension/meeting-links.js';
import {validateMeeting} from '../server/core.js';
test('Google Meet, Zoom web join/start, and Teams URL variants share stable room identities',()=>{
 for(const urls of [
  ['https://meet.google.com/abc-defg-hij','https://meet.google.com/meet/abc-defg-hij?authuser=1','https://meet.google.com/ABC-DEFG-HIJ/'],
  ['https://us02web.zoom.us/j/12345678901?pwd=secret','https://app.zoom.us/wc/12345678901/join?from=web','https://zoom.us/wc/12345678901/start','https://zoom.us/wc/join/12345678901','https://zoom.us/s/12345678901','https://zoom.us/w/12345678901'],
  ['https://teams.microsoft.com/meet/123456789012?p=private','https://teams.cloud.microsoft/meet/123456789012?webjoin=true&p=private'],
  ['https://teams.microsoft.com/l/meetup-join/19%3ameeting_fixture%40thread.v2/0?context=%7B%7D','https://teams.cloud.microsoft/l/meetup-join/19%3Ameeting_fixture%40thread.v2/0?anon=true&context=%7B%7D']
 ]) {const key=meetingRoom(urls[0]);for(const url of urls){assert.equal(meetingRoom(url),key);const input=validateMeeting({mode:'live',title:'Link regression',meetingLink:url});assert.equal(meetingRoom(input.meetingLink),key);}}
 assert.match(meetingInvitation('https://app.zoom.us/wc/12345678901/start?pwd=private'),/\/j\/12345678901\?pwd=private$/);
 assert.match(meetingInvitation('https://teams.cloud.microsoft/meet/123456789012?p=private'),/^https:\/\/teams.microsoft.com\/meet\/123456789012\?p=private$/);
 assert.notEqual(meetingRoom('https://teams.live.com/meet/123456789012'),meetingRoom('https://teams.microsoft.com/meet/123456789012'));
 assert.notEqual(meetingRoom('https://zoom.us/j/12345678901'),meetingRoom('https://zoom.us/j/12345678902'));
});
test('every creation path rejects homepages, broken invitations and lookalike hosts',()=>{
 for(const url of ['https://meet.google.com/','https://meet.google.com/meet/','https://zoom.us/','https://zoom.us/j/123','https://zoom.us/my/room','https://teams.microsoft.com/meet/','https://teams.microsoft.com/l/meetup-join/','https://teams.microsoft.com/v2/','https://teams.live.com/meet/not-an-id','http://zoom.us/j/12345678901','https://zoom.us.evil.example/j/12345678901','https://teams.cloud.microsoft.evil.example/meet/123456789012','https://user:pass@zoom.us/j/12345678901','https://zoom.us:8443/j/12345678901','https://teams.microsoft.com/l/meetup-join/19%3Ameeting%2Fother/0']) {
  assert.throws(()=>meetingRoom(url),undefined,url);assert.throws(()=>validateMeeting({mode:'live',title:'Invalid room',meetingLink:url}),undefined,url);
 }
});
