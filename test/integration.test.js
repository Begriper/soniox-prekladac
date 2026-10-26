const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { fixture, until } = require("./helpers/mock-runtime.cjs");
async function setup(t, options) { const f = await fixture(options); t.after(()=>f.close()); return f; }
test("HTTP/WS auth rejects malformed cookies, wrong origins, null JSON and bad frames without crashing", async t => {
  const f=await setup(t), cookie=await f.login();
  assert.equal((await f.request("/api/session",undefined,"sl_session=%E0%A4%A")).status,401);
  const bad = await fetch(f.url+"/api/logout",{method:"POST",headers:{Origin:"http://evil.test","Content-Type":"application/json"},body:"{}"});
  assert.equal(bad.status,403);
  for (const [origin, token, expected] of [[f.origin,"sl_session=%ZZ",401],["http://evil.test",cookie,403]]) {
    const ws=new WebSocket(f.url.replace("http","ws"),{origin,headers:{Cookie:token}});
    const code=await new Promise(resolve=>{ ws.on("unexpected-response",(_r,res)=>{resolve(res.statusCode);res.destroy();ws.terminate();});ws.on("error",()=>{}); });
    assert.equal(code,expected);
  }
  for (const invalid of ["null","duplicate","frame"]) {
    const ws=await f.connect(cookie);
    await until(()=>ws.messages.some(m=>m.type==="server_ready"));
    if (invalid==="frame") ws.send("bad frame",{mask:false});
    else ws.send(invalid==="null"?"null":JSON.stringify({type:"config"}));
    await until(()=>ws.readyState===WebSocket.CLOSED);
    assert.equal((await f.request("/health")).status,200);
  }
});
test("logout terminates active paid speech session", async t => {
  const f=await setup(t), cookie=await f.login(), ws=await f.connect(cookie);
  await until(()=>f.state.configs.length===1);
  assert.equal((await f.request("/api/logout",{},cookie)).status,200);
  await until(()=>ws.readyState===3);
  assert.equal(f.runtime.conversations.size,0);
  assert.equal((await f.request("/api/session",undefined,cookie)).status,401);
});
test("two directions remain separate; stale playback acknowledgement cannot release new audio", async t => {
  const f=await setup(t), cookie=await f.login(), ws=await f.connect(cookie);
  await until(()=>f.state.configs.length===1);
  f.turn(f.state.stt[0]);
  await until(()=>ws.messages.some(m=>m.type==="tts_stream_end"));
  const first=ws.messages.find(m=>m.type==="tts_stream_start");
  ws.send(JSON.stringify({type:"playback_done",playback_id:"old",status:"played"}));
  await new Promise(r=>setTimeout(r,30));
  const session=[...f.runtime.conversations.values()][0]; assert.equal(session.playback.id,first.playback_id);
  ws.send(JSON.stringify({type:"playback_done",playback_id:first.playback_id,status:"played"}));
  await until(()=>!session.playback);
  f.turn(f.state.stt[0],true);
  await until(()=>ws.messages.filter(m=>m.type==="tts_stream_end").length===2);
  const byId=new Map();
  for (const m of ws.messages.filter(m=>m.type==="token")) for (const i of m.conversation_items) byId.set(i.id,i);
  const items=[...byId.values()];
  assert.deepEqual(items.map(i=>[i.source_language,i.target_language]),[["sk","de"],["de","sk"]]);
  assert.equal(items.length,2); assert.ok(ws.audio.length>=2);
  const last=ws.messages.filter(m=>m.type==="token").at(-1);
  assert.ok(last.conversation_items.length<2, "updates carry only changed items");
});
test("auto mode is silent until confirmation opens fixed two-way pair", async t => {
  const f=await setup(t), cookie=await f.login(), ws=await f.connect(cookie,{language_a:"sk",language_b:"auto"});
  await until(()=>f.state.configs.length===1); f.turn(f.state.stt[0],true);
  await until(()=>ws.messages.some(m=>m.type==="language_candidate"));
  assert.equal(ws.audio.length,0); assert.equal(f.state.rest.length,0);
  ws.send(JSON.stringify({type:"confirm_language",language:"de"}));
  await until(()=>f.state.configs.length===2);
  assert.deepEqual(f.state.configs[1].config.translation,{type:"two_way",language_a:"sk",language_b:"de"});
});
test("transport failure falls back once; partial audio and authorization errors never replay via REST", async t => {
  for (const mode of ["fail","partial","unauthorized"]) await t.test(mode,async t=>{
    const f=await setup(t); f.state.mode=mode;
    const cookie=await f.login(), ws=await f.connect(cookie);
    await until(()=>f.state.configs.length===1); f.turn(f.state.stt[0]);
    await until(()=>ws.messages.some(m=>m.type==="tts_stream_end"));
    assert.equal(f.state.rest.length,mode==="fail"?1:0);
    assert.equal(f.runtime.store.read("owner").ttsRequests,mode==="fail"?2:1);
  });
});
test("Stop during REST aborts operation; late response cannot restart audio", async t => {
  const f=await setup(t,{env:{TTS_TRANSPORT:"rest"}}); f.state.restDelay=200;
  const cookie=await f.login(), ws=await f.connect(cookie);
  await until(()=>f.state.configs.length===1); f.turn(f.state.stt[0]);
  await until(()=>f.state.rest.length===1);
  ws.send(JSON.stringify({type:"stop_audio",request_id:"cancel-1"}));
  await until(()=>ws.messages.some(m=>m.type==="audio_cancelled"&&m.request_id==="cancel-1"));
  await new Promise(r=>setTimeout(r,250));
  assert.equal(ws.audio.length,0);
  assert.equal([...f.runtime.conversations.values()][0].playback,null);
});
test("preview accepts fixed text only and reserves quota before concurrent requests", async t => {
  const f=await setup(t,{env:{MAX_USER_TTS_REQUESTS_PER_DAY:"1"}}); f.state.restDelay=80;
  const cookie=await f.login();
  const responses=await Promise.all([1,2,3].map(()=>f.request("/api/preview-voice",{language:"sk",voice:"Adrian",text:"attacker supplied text"},cookie)));
  assert.equal(responses.filter(r=>r.status===200).length,1);
  assert.equal(f.state.rest.length,1);
  assert.equal(f.state.rest[0].text,"Dobrý deň. Toto je ukážka hlasu.");
  assert.equal((await f.request("/api/replay",{text:"hello",language:"en",voice:"Adrian"},cookie)).status,429);
});
test("saved text replay validates length and uses the configured TTS model", async t => {
  const f=await setup(t), cookie=await f.login();
  assert.equal((await f.request("/api/replay",{text:"x".repeat(901),language:"en",voice:"Adrian"},cookie)).status,400);
  assert.equal((await f.request("/api/replay",{text:"hello",language:"en",voice:"Adrian"},cookie)).status,200);
  assert.equal(f.state.rest[0].model,"tts-rt-v2");
});

test("two transport failures switch subsequent synthesis to REST for sixty seconds", async t => {
  const f=await setup(t); f.state.mode="fail";
  const cookie=await f.login(), ws=await f.connect(cookie);
  await until(()=>f.state.configs.length===1);
  for (let i=1;i<=3;i++) {
    f.turn(f.state.stt[0],i%2===0);
    await until(()=>ws.messages.filter(m=>m.type==="tts_stream_end").length===i);
    const end=ws.messages.filter(m=>m.type==="tts_stream_end").at(-1);
    ws.send(JSON.stringify({type:"playback_done",playback_id:end.playback_id,status:"played"}));
    await until(()=>![...f.runtime.conversations.values()][0].playback);
  }
  assert.equal(f.state.rest.length,3);
  assert.equal(f.runtime.store.read("owner").ttsRequests,5);
  const session=[...f.runtime.conversations.values()][0];
  assert.ok(session.restUntil>Date.now());
});
test("session audio exhaustion does not spend another REST fallback request", async t => {
  const f=await setup(t);
  const cookie=await f.login(), ws=await f.connect(cookie);
  await until(()=>f.state.configs.length===1);
  [...f.runtime.conversations.values()][0].limits.sessionTtsBytes=1000;
  f.turn(f.state.stt[0]);
  await until(()=>ws.messages.some(m=>m.type==="tts_stream_end"));
  assert.equal(f.state.rest.length,0);
  assert.equal(f.runtime.store.read("owner").ttsRequests,1);
});
