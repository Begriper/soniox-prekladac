const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { parseCookies, parseMessage, validOrigin, clientIp, WindowLimiter } = require("../security");
const { UsageStore } = require("../usage-store");
const { Catalog } = require("../catalog");
test("malformed cookies and primitive messages fail safely", () => {
  assert.equal(parseCookies("sl_session=%E0%A4%A").sl_session, undefined);
  for (const value of ["null", "[]", "42", '""', "{}", '{"type":"config","tts_enabled":"yes"}']) assert.equal(parseMessage(value), null);
  assert.equal(parseMessage('{"type":"playback_done","playback_id":"old"}').playback_id, "old");
});
test("origin matches scheme and port; forwarded IP is not trusted by default", () => {
  const allowed = new Set(["https://example.com"]);
  for (const origin of ["http://example.com", "https://example.com:444", "https://example.com.evil.test", undefined]) assert.equal(validOrigin({headers:{origin}}, allowed), false);
  assert.equal(clientIp({ headers: {"x-forwarded-for":"1.1.1.1","fly-client-ip":"2.2.2.2"}, socket:{remoteAddress:"127.0.0.1"} }), "127.0.0.1");
});
test("login limiter bounds storage and expires old entries", () => {
  const limiter = new WindowLimiter(1, 10, 1);
  assert.equal(limiter.allow("a", 0), true); assert.equal(limiter.allow("a", 1), false);
  assert.equal(limiter.allow("b", 2), false); assert.equal(limiter.allow("b", 11), true);
});
test("transaction reservations cannot exceed shared limits and persist across restart", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "translator-usage-test-"));
  const file = path.join(dir, "test.sqlite");
  const a = new UsageStore(file, {ttsRequests:2,ttsChars:10});
  const b = new UsageStore(file, {ttsRequests:2,ttsChars:10});
  assert.equal(a.reserve("owner",{ttsRequests:1,ttsChars:6}),true);
  assert.equal(b.reserve("owner",{ttsRequests:1,ttsChars:6}),false);
  assert.equal(b.read("owner").ttsRequests,1);
  assert.equal(b.reserve("owner",{ttsRequests:1,ttsChars:4}),true);
  assert.equal(a.reserve("owner",{ttsRequests:1}),false);
  a.close(); b.close();
  const c = new UsageStore(file, {ttsRequests:2});
  assert.equal(c.read("owner").ttsRequests,2);
  assert.equal(c.read("family").ttsRequests,0);
  c.close(); assert.throws(()=>c.reserve("owner",{ttsRequests:1}));
  // Only remove the exact files this test created.
  for (const name of ["test.sqlite","test.sqlite-wal","test.sqlite-shm"]) { const f=path.join(dir,name); if(fs.existsSync(f)) fs.unlinkSync(f); }
  fs.rmdirSync(dir);
});
test("failed catalog refresh preserves last good model and all its languages", async () => {
  const store = new UsageStore(":memory:");
  let available = true;
  const catalog = new Catalog({store,urls:{stt:"mock",tts:"mock"},apiKey:"mock",fetchImpl:async()=> {
    if (!available) throw new Error("offline");
    return {ok:true,json:async()=>({models:[{id:"stt-rt-v5",languages:["sk","de","es","en","ar","zh"]}]})};
  }});
  const first = await catalog.get("stt"); assert.equal(first.languages.length,6);
  catalog.data.get("stt").updated_at = "2000-01-01T00:00:00Z"; available=false;
  const stale=await catalog.get("stt"); assert.equal(stale.languages.length,6); assert.equal(stale.stale,true);
  assert.equal(catalog.canSpeak("sr","Здраво"),false);
  store.close();
});
