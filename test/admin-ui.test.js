"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

test("client renders content without HTML injection sinks", () => {
  const source = readFileSync(join(__dirname, "../public/app.js"), "utf8");
  assert.doesNotMatch(source, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/);
});

test("admin sheets have accessible dialog titles", () => {
  const html = readFileSync(join(__dirname, "../public/index.html"), "utf8");
  for (const [id, title] of [["adminSheet", "adminTitle"], ["userSheet", "userTitle"], ["newUserSheet", "newUserTitle"]]) {
    assert.match(html, new RegExp('<dialog\\b[^>]*id="' + id + '"[^>]*aria-labelledby="' + title + '"'));
    assert.match(html, new RegExp('<h2\\b[^>]*id="' + title + '"'));
  }
});

// Exercise the actual client helpers with a minimal DOM, without a browser dependency.
function client() {
  class Node {
    constructor() { this.children = []; this.attributes = {}; this.style = {}; this.events = {}; this.value = ""; this.hidden = false; this.open = false; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return (this.text || "") + this.children.map(n => n.textContent).join(""); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.text = ""; this.children = nodes; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(key, fn) { this.events[key] = fn; }
    scrollIntoView() {}
    reset() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.events.close?.(); }
  }
  const nodes = new Map(), get = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const context = vm.createContext({ document: { getElementById: get, createElement: () => new Node(), querySelectorAll: () => [], body: new Node() }, navigator: {}, location: { origin: "https://translator.test" }, AbortSignal, setTimeout: () => 0, clearTimeout() {} });
  const source = readFileSync(join(__dirname, "../public/app.js"), "utf8");
  vm.runInContext(source.slice(0, source.indexOf("/* ---------- audio playback ---------- */")), context);
  vm.runInContext(source.slice(source.indexOf('$("adminBtn").addEventListener'), source.indexOf('$("newBtn").addEventListener')), context);
  const run = code => vm.runInContext(code, context);
  run('user = "owner"; adminRole = true;');
  return { get, run, context };
}

test("limit inputs convert minutes to seconds, retain zero and reset all-empty overrides", () => {
  const c = client();
  c.get("limitMinutes").value = "1.5"; c.get("limitChars").value = "0"; c.get("limitMonth").value = "10";
  assert.equal(c.run("JSON.stringify(readLimits(LIMIT_FIELDS))"), '{"sttSeconds":90,"ttsChars":0,"sttSecondsMonth":600}');
  c.get("limitMinutes").value = ""; c.get("limitChars").value = ""; c.get("limitMonth").value = "";
  assert.equal(c.run("readLimits(LIMIT_FIELDS, { audioBytes: 123 })"), null);
  c.get("limitMinutes").value = "-1";
  assert.throws(() => c.run("readLimits(LIMIT_FIELDS)"), /Limit/);
});

test("usage bars warn only above eighty percent and display effective account limits", () => {
  const c = client();
  assert.equal(c.run('usageBar("Test", 80, 100).children[1].children[0].className'), "usage-fill");
  assert.equal(c.run('usageBar("Test", 81, 100).children[1].children[0].className'), "usage-fill warning");
  c.run('showUsage({ sttSeconds: 90, ttsChars: 200, sessions: 2, limits: { sttSeconds: 600, ttsChars: 1000, sessions: 10 } })');
  assert.match(c.get("usageInfo").textContent, /1,5 \/ 10/);
  assert.match(c.get("usageInfo").textContent, /200 \/ 1\s000/);
  assert.equal(c.run("relative(Date.now() - 7200000)"), "pred 2 h");
  assert.equal(c.run("relative(new Date(Date.now() - 7200000).toISOString())"), "pred 2 h");
});

test("user detail hides self-destructive actions and renders hostile notes as text", () => {
  const c = client();
  c.run('renderUser({ username: "owner", role: "admin", note: "<img src=x onerror=alert(1)>", month: {}, limits_effective: {}, sessions: [] })');
  assert.equal(c.get("userNote").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(c.get("userActions").children.length, 2);
  c.run('renderUser({ username: "family", role: "user", month: {}, limits_effective: {}, sessions: [] })');
  assert.equal(c.get("userActions").children.length, 5);
});

function passkeyClient() {
  const c = client(), storage = new Map();
  Object.assign(c.context, { AbortController, atob, btoa, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, window: {} });
  c.run('PublicKeyCredential = window.PublicKeyCredential = { isUserVerifyingPlatformAuthenticatorAvailable: async () => true, isConditionalMediationAvailable: async () => false };');
  return { ...c, storage };
}
test("passkey controls require platform support and a local registration flag", async () => {
  const c = passkeyClient();
  await c.run("initPasskeys()");
  assert.equal(c.get("passkeyBtn").hidden, false); assert.equal(c.get("passkeyLoginBtn").hidden, true);
  c.run('saveDevicePasskeys({ owner: ["credential"] })');
  assert.equal(c.get("passkeyState").textContent, "Zapnuté na tomto zariadení"); assert.equal(c.get("passkeyLoginBtn").hidden, false);
  c.run('user = "family"; renderPasskeyState()'); assert.equal(c.get("passkeyState").textContent, "Vypnuté");
  c.run('PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => false;');
  await c.run("initPasskeys()"); assert.equal(c.get("passkeyBtn").hidden, true); assert.equal(c.get("passkeyLoginBtn").hidden, true);
  c.run('window.PublicKeyCredential = undefined;'); await c.run("initPasskeys()"); assert.equal(c.get("passkeyBtn").hidden, true);
});
test("client base64url conversions preserve binary data", () => {
  const c = passkeyClient();
  assert.equal(c.run('toBase64url(fromBase64url("AP_-AQ"))'), "AP_-AQ");
});
test("passkey list uses text nodes and removing the last local key clears its device flag", async () => {
  const c = passkeyClient(); c.get("passkeySheet").open = true;
  c.run('passkeyAvailable = true; saveDevicePasskeys({ owner: ["local-key"] }); globalThis.keys = [{ id: "local-key", label: "<img src=x>", created_at: "2026-10-26", last_used_at: null }]; api = async (url, options) => { if (options) { keys = []; return { ok: true }; } return { passkeys: keys }; };');
  await c.run("loadPasskeys()"); assert.match(c.get("passkeyList").textContent, /<img src=x>/);
  const remove = c.get("passkeyList").children[0].children.at(-1); await remove.events.click();
  assert.equal(c.storage.get("translator.passkey"), "0"); assert.equal(c.get("passkeyLoginBtn").hidden, true);
  assert.equal(c.get("passkeyState").textContent, "Vypnuté");
});
test("conditional get is aborted before explicit passkey get and successful login uses showApp", async () => {
  const c = passkeyClient(); c.run('user = null; passkeyAvailable = true; saveDevicePasskeys({ owner: ["a"] });');
  c.context.credential = { id: "YQ", rawId: Uint8Array.of(97).buffer, type: "public-key", response: { clientDataJSON: Uint8Array.of(1).buffer, authenticatorData: Uint8Array.of(2).buffer, signature: Uint8Array.of(3).buffer, userHandle: Uint8Array.of(4).buffer } };
  c.run('globalThis.gets = []; navigator.credentials = { get: async options => { gets.push(options); if (options.mediation) return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))); return credential; } }; api = async (url, options) => url.endsWith("options") ? { challenge: "YQ", rpId: "localhost", allowCredentials: [] } : { authenticated: true, username: "owner" }; showApp = async data => { globalThis.loggedIn = data.username; };');
  const pending = c.run("passkeyLogin(true)"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.run('gets[0].mediation'), "conditional");
  await c.run("passkeyLogin()"); await pending;
  assert.equal(c.run('gets[0].signal.aborted'), true); assert.equal(c.run('gets.length'), 2); assert.equal(c.run('loggedIn'), "owner");
  assert.equal(c.get("passkeyLoginBtn").disabled, false);
});
test("unknown credential clears the local flag and leaves a short password fallback message", async () => {
  const c = passkeyClient();
  c.run('user = null; passkeyAvailable = true; saveDevicePasskeys({ owner: ["a"] }); api = async () => { const err = new Error("unknown"); err.code = "unknown_credential"; throw err; };');
  await c.run("passkeyLogin()");
  assert.equal(c.storage.get("translator.passkey"), "0"); assert.equal(c.get("passkeyLoginBtn").hidden, true);
  assert.match(c.get("loginStatus").textContent, /meno a heslo/); assert.equal(c.get("passkeyLoginBtn").disabled, false);
});
test("conditional mediation is requested only on a registered device and respects password submission", async () => {
  const c = passkeyClient();
  c.run('user = null; passkeyAvailable = true; PublicKeyCredential.isConditionalMediationAvailable = async () => true; globalThis.calls = 0; passkeyLogin = async conditional => { calls += Number(conditional); };');
  await c.run("conditionalPasskeyLogin()"); assert.equal(c.run("calls"), 0);
  c.run('saveDevicePasskeys({ owner: ["a"] }); passwordBusy = true;');
  await c.run("conditionalPasskeyLogin()"); assert.equal(c.run("calls"), 0);
  c.run('passwordBusy = false;'); await c.run("conditionalPasskeyLogin()"); assert.equal(c.run("calls"), 1);
});
test("registration converts options, posts browser public key accessors and remembers this device", async () => {
  const c = passkeyClient(), bytes = Uint8Array.of(97).buffer;
  c.context.credential = { id: "YQ", rawId: bytes, type: "public-key", response: { clientDataJSON: bytes, attestationObject: bytes,
    getPublicKey: () => bytes, getPublicKeyAlgorithm: () => -7, getAuthenticatorData: () => bytes, getTransports: () => ["internal"] } };
  c.run('navigator.credentials = { create: async options => { globalThis.creation = options.publicKey; return credential; } }; api = async (url, options) => { if (url.endsWith("options")) return { challenge: "YQ", user: { id: "Yg" }, excludeCredentials: [{ type: "public-key", id: "Yw" }] }; globalThis.registration = JSON.parse(options.body); return { ok: true }; }; loadPasskeys = async () => {};');
  await c.run("createPasskey()");
  assert.equal(c.run("creation.challenge[0]"), 97); assert.equal(c.run("creation.user.id[0]"), 98); assert.equal(c.run("creation.excludeCredentials[0].id[0]"), 99);
  assert.equal(c.run("registration.response.publicKey"), "YQ"); assert.equal(c.run("registration.response.publicKeyAlgorithm"), -7);
  assert.equal(c.run("registration.response.authenticatorData"), "YQ"); assert.equal(c.run("registration.response.transports[0]"), "internal");
  assert.equal(c.storage.get("translator.passkey"), "1"); assert.match(c.storage.get("translator.passkeyIds"), /YQ/);
  assert.equal(c.get("passkeyCreateBtn").disabled, false);
});
test("unsupported registration accessors give a clear message and never set the device flag", async () => {
  const c = passkeyClient();
  c.run('navigator.credentials = { create: async () => ({ response: {} }) }; api = async () => ({ challenge: "YQ", user: { id: "Yg" }, excludeCredentials: [] });');
  await c.run("createPasskey()"); assert.match(c.get("passkeyStatus").textContent, /Prehliadač neposkytuje verejný kľúč/);
  assert.equal(c.storage.get("translator.passkey"), undefined); assert.equal(c.get("passkeyCreateBtn").disabled, false);
});
test("admin removal of own passkeys also clears the local device state", async () => {
  const c = passkeyClient();
  c.run('saveDevicePasskeys({ owner: ["a"] }); api = async () => ({ ok: true }); refreshAdmin = async () => {}; toast = () => {};');
  await c.run('mutateUser("owner", "passkeys/delete", {})');
  assert.equal(c.storage.get("translator.passkey"), "0"); assert.equal(c.get("passkeyState").textContent, "Vypnuté");
});
test("password form aborts an outstanding passkey get and retains the original password login flow", async () => {
  const c = passkeyClient(), source = readFileSync(join(__dirname, "../public/app.js"), "utf8");
  c.run(source.slice(source.indexOf('$("loginForm").addEventListener'), source.indexOf('$("startBtn").addEventListener')));
  c.run('passkeyAbort = new AbortController(); globalThis.pendingSignal = passkeyAbort.signal; globalThis.passwordSubmit = { disabled: false }; api = async (url, options) => { globalThis.passwordBody = JSON.parse(options.body); return { username: "owner" }; }; showApp = async data => { globalThis.passwordUser = data.username; };');
  c.get("username").value = "owner"; c.get("accessCode").value = "test-password";
  await c.get("loginForm").events.submit({ preventDefault() {}, currentTarget: { querySelector: selector => { assert.equal(selector, 'button[type="submit"]'); return c.context.passwordSubmit; } } });
  assert.equal(c.run("pendingSignal.aborted"), true); assert.equal(c.run("passwordBody.password"), "test-password"); assert.equal(c.run("passwordUser"), "owner");
  assert.equal(c.context.passwordSubmit.disabled, false); assert.equal(c.get("passkeyLoginBtn").disabled, false);
});

test("user chart fills missing UTC days and ignores a late response after closing", async () => {
  const c = client(); c.get("userSheet").open = true;
  c.context.chartData = { from: "2026-10-01", to: "2026-10-30", days: [{ day: "2026-10-02", sttSeconds: 120 }], totals: { sttSeconds: 120 } };
  c.run('selectedUser = "family"; api = async () => chartData;');
  await c.run('loadUserChart("family")');
  assert.equal(c.get("userChart").children[0].children.length, 30);
  assert.equal(c.get("userChart").children[0].children[1].style.height, "100%");
  assert.match(c.get("userChart").children[0].attributes["aria-label"], /2026-10-02: 2/);
  c.run('api = () => new Promise(resolve => globalThis.complete = resolve);');
  const pending = c.run('loadUserChart("family")');
  c.get("userSheet").close(); c.get("userChart").textContent = "closed";
  c.run("complete(chartData)"); await pending;
  assert.equal(c.get("userChart").textContent, "closed");
});

test("invitations are text-only and removed on both sheet close paths", () => {
  const c = client();
  for (const [sheet, card] of [["userSheet", "userInvitation"], ["newUserSheet", "newInvitation"]]) {
    c.run('invitation("' + card + '", { username: "<user>", password: "<password>" })');
    assert.match(c.get(card).textContent, /Prekladač: https:\/\/translator.test\nMeno: <user>\nHeslo: <password>/);
    c.get(sheet).close();
    assert.equal(c.get(card).textContent, ""); assert.equal(c.get(card).hidden, true);
  }
});

test("creation sends optional limits and shows the returned password only in the open sheet", async () => {
  const c = client(); c.get("newUsername").value = "family"; c.get("newMinutes").value = "2"; c.get("newUserSheet").open = true;
  c.run('api = async (url, options) => { globalThis.sent = JSON.parse(options.body); return { username: "family", password: "generated-test" }; }; refreshAdmin = async () => {};');
  await c.run("createUser({ preventDefault() {} })");
  assert.equal(c.run("sent.limits.sttSeconds"), 120);
  assert.equal(c.run("sent.role"), "user"); assert.equal(c.run("sent.password"), undefined);
  assert.match(c.get("newInvitation").textContent, /generated-test/);
  c.get("newUserSheet").close();
  await c.run("createUser({ preventDefault() {} })");
  assert.equal(c.get("newInvitation").textContent, "");
});
