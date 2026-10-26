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
