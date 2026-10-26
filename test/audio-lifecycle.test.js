const test = require("node:test"), assert = require("node:assert/strict");
const vm = require("node:vm"), fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { SpeechSession } = require("../speech-session");
const { chunkTextForTts } = require("../server-utils");
test("Worklet flush includes final partial sample and marks a just-filled chunk", () => {
  let Processor; const messages=[];
  class Base { constructor(){this.port={postMessage:m=>messages.push(m)};} }
  vm.runInNewContext(fs.readFileSync("public/audio-capture-worklet.js","utf8"),{
    AudioWorkletProcessor:Base,sampleRate:48000,registerProcessor:(_n,c)=>{Processor=c;},
    Int16Array,Math
  });
  const p=new Processor({processorOptions:{targetSampleRate:16000,chunkSize:1024}});
  p.process([[new Float32Array(3070).fill(.5)]],[[]]);
  assert.equal(messages.length,0);
  p.port.onmessage({data:{type:"flush"}});
  assert.equal(messages[0].buffer.byteLength,2048);
  assert.equal(messages[0].flush,true);
  assert.equal(new Int16Array(messages[0].buffer)[1023],16383);
  assert.equal(messages[1].type,"flushed");
  p.port.onmessage({data:{type:"flush"}});
  assert.equal(messages.filter(m=>m.type==="audio").length,1);
});
test("bounded chunks do not split surrogate pairs or lose unspaced text", () => {
  const text="a".repeat(899)+"😀"+"b".repeat(1000);
  const chunks=chunkTextForTts(text,900);
  assert.equal(chunks.join(""),text);
  assert.ok(chunks.every(c=>c.length<=900 && c.isWellFormed()));
});
function localSession(t, expiresAt = Date.now() + 3600000) {
  const client=new EventEmitter(); client.readyState=1;client.bufferedAmount=0;
  client.messages=[];client.send=m=>client.messages.push(JSON.parse(m)); client.ping=()=>{};
  client.terminate=()=>{client.readyState=3;};client.close=()=>{client.readyState=3;};
  const reservations=[];
  const session=new SpeechSession(client,{
    auth:{id:"test",username:"owner",expiresAt},ip:"127.0.0.1",
    store:{reserve:(_u,patch)=>{reservations.push(patch);return true;}},
    catalog:{hasLanguage:()=>true,hasVoice:()=>true,canSpeak:()=>true},
    urls:{ttsWs:"ws://127.0.0.1:1"},limits:{sessionMs:3600000,idleMs:3600000,sessionTtsRequests:120},
    endpoint:{delay:1500,level:0,sensitivity:0},transport:"rest"
  });
  t.after(()=>session.close()); return {session,client,reservations};
}
test("STT keepalive continues every ten seconds while local replay mutes microphone", t => {
  t.mock.timers.enable({apis:["setInterval"]});
  const {session,reservations}=localSession(t);
  const sent=[]; session.stt={readyState:1,send:m=>sent.push(JSON.parse(m)),terminate:()=>{}};
  session.configured=true; session.acceptAudio=true;session.localPlayback="local-1";
  t.mock.timers.tick(10000);
  assert.deepEqual(sent,[{type:"keepalive"}]);
  assert.deepEqual(reservations,[{sttSeconds:10}]);
});
test("session expiry closes live operation even without another HTTP request", t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  const {session,client}=localSession(t);
  clearTimeout(session.configTimer); session.configured=true;
  // Exercise the same expiry action through the existing registered timer.
  t.mock.timers.tick(3600001);
  assert.equal(session.closed,true);
  assert.equal(client.readyState,3);
  assert.ok(client.messages.some(m=>m.code==="auth_expired"));
});
test("30-day logins do not overflow the live conversation expiry timer", t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  const {session,client}=localSession(t,Date.now()+30*86400000);
  clearTimeout(session.configTimer); session.configured=true;
  t.mock.timers.tick(1000);
  assert.equal(session.closed,false);
  assert.equal(client.messages.some(m=>m.code==="auth_expired"),false);
});
test("queue overload preserves previous jobs and marks the new text unspoken", t => {
  const {session,client}=localSession(t);
  session.pump=()=>{};
  session.enqueue("first","de","one");session.enqueue("second","de","two");
  const previous=session.queue.slice();
  session.enqueue("word ".repeat(1000),"de","overflow");
  assert.deepEqual(session.queue,previous);
  assert.equal(session.audioStates.get("overflow"),"not_spoken");
  assert.ok(client.messages.some(m=>m.code==="voice_overload"));
});

