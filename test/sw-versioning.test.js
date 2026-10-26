const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { fixture } = require("./helpers/mock-runtime.cjs");
const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const version = JSON.parse(read("package.json")).version;
const source = read("public/sw.js");
const { CACHE, SHELL } = vm.runInNewContext(source + "; ({ CACHE, SHELL });", { self: { addEventListener() {} } });

test("release versions, HTML, worklet, manifest and cached shell URLs agree", () => {
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[""].version, version);
  assert.equal(read("server.js").match(/const APP_VERSION = "([^"]+)"/)[1], version);
  assert.equal(CACHE, "translator-shell-" + version);
  const htmlUrls = [...read("public/index.html").matchAll(/(?:src|href)="(\/[^\"]+)"/g)].map(m => m[1]);
  const workletUrls = [...read("public/app.js").matchAll(/audioWorklet\.addModule\("([^"]+)"\)/g)].map(m => m[1]);
  const iconUrls = JSON.parse(read("public/manifest.webmanifest")).icons.map(icon => icon.src);
  assert.equal(htmlUrls.length, 6);
  assert.equal(workletUrls.length, 1);
  for (const url of [...htmlUrls, ...workletUrls, ...iconUrls]) {
    assert.equal(new URL(url, "https://unit.test").search, "?v=" + version, url);
    assert.ok(SHELL.includes(url), url + " must be precached");
  }
  assert.ok(SHELL.includes("/"));
  assert.ok(SHELL.includes("/index.html"));
  assert.ok(SHELL.includes("/fonts/Manrope-variable.ttf"));
  for (const entry of SHELL) {
    const url = new URL(entry, "https://unit.test");
    if (!["/", "/index.html", "/fonts/Manrope-variable.ttf"].includes(url.pathname)) {
      assert.equal(url.search, "?v=" + version, entry);
    }
    const file = path.join(root, "public", url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    assert.ok(fs.statSync(file).isFile(), entry + " must exist in public/");
  }
});

function worker(fetchImpl) {
  const origin = "https://unit.test";
  const handlers = {}, stores = new Map(), calls = [];
  let skipped = false, claimed = false, quotaFull = false;
  const key = request => new URL(typeof request === "string" ? request : request.url, origin).href;
  const fetch = async request => { calls.push(key(request)); return fetchImpl(request); };
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(request) { return store.get(key(request))?.clone(); },
        async put(request, response) { if (quotaFull) throw new Error("QuotaExceededError"); store.set(key(request), response.clone()); },
        async addAll(urls) {
          const entries = await Promise.all(urls.map(async url => {
            const response = await fetch(url);
            if (!response.ok) throw new Error("Precache failed: " + url);
            return [key(url), response];
          }));
          for (const [url, response] of entries) store.set(url, response);
        }
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); }
  };
  vm.runInNewContext(source, {
    URL, Response, caches, fetch,
    self: {
      location: { origin },
      addEventListener(type, handler) { handlers[type] = handler; },
      async skipWaiting() { skipped = true; },
      clients: { async claim() { claimed = true; } }
    }
  });
  return {
    caches, calls, stores,
    get skipped() { return skipped; },
    get claimed() { return claimed; },
    set quotaFull(value) { quotaFull = value; },
    async lifecycle(type) {
      const pending = [];
      handlers[type]({ waitUntil(promise) { pending.push(promise); } });
      await Promise.all(pending);
    },
    request(url, options = {}) {
      let response; const pending = [];
      handlers.fetch({
        request: { url: new URL(url, origin).href, method: "GET", mode: "cors", ...options },
        respondWith(promise) { response = promise; },
        waitUntil(promise) { pending.push(promise); }
      });
      return response && response.then(async result => { await Promise.all(pending); return result; });
    }
  };
}

test("install precaches the complete shell before skipping; activate deletes only older shell caches and claims clients", async () => {
  const w = worker(async () => new Response("current"));
  await w.caches.open("translator-shell-v3-2");
  await w.caches.open("unrelated-cache");
  await w.lifecycle("install");
  assert.equal(w.skipped, true);
  assert.equal(w.stores.get(CACHE).size, SHELL.length);
  await w.lifecycle("activate");
  assert.deepEqual(await w.caches.keys(), ["unrelated-cache", CACHE]);
  assert.equal(w.claimed, true);
  const failed = worker(async url => new Response("unavailable", { status: url.includes("app.js") ? 503 : 200 }));
  await assert.rejects(failed.lifecycle("install"), /Precache failed/);
  assert.equal(failed.skipped, false);
});

test("versioned assets are cache-first and a missing asset never falls back to an old URL or cache", async () => {
  let offline = false;
  const w = worker(async () => {
    if (offline) throw new Error("offline");
    return new Response("current asset");
  });
  const old = await w.caches.open("translator-shell-v3-2");
  await old.put("/app.js", new Response("old asset"));
  await old.put("/app.js?v=" + version, new Response("wrong cache"));
  await w.lifecycle("install");
  const count = w.calls.length;
  offline = true;
  for (const asset of ["/app.js", "/style.css", "/audio-capture-worklet.js"]) {
    assert.equal(await (await w.request(asset + "?v=" + version)).text(), "current asset");
  }
  assert.equal(w.calls.length, count);
  const current = await w.caches.open(CACHE);
  await current.put("/app.js", new Response("unversioned asset"));
  w.stores.get(CACHE).delete("https://unit.test/app.js?v=" + version);
  await assert.rejects(w.request("/app.js?v=" + version), /offline/);
  offline = false;
  assert.equal(await (await w.request("/app.js?v=" + version)).text(), "current asset");
  offline = true;
  assert.equal(await (await w.request("/app.js?v=" + version)).text(), "current asset");
});

test("navigations use the network then the current cache's canonical HTML, including query URLs and HTTP failures", async () => {
  let mode = "online";
  const w = worker(async () => {
    if (mode === "offline") throw new Error("offline");
    return new Response("network shell", { status: mode === "unavailable" ? 503 : 200 });
  });
  const old = await w.caches.open("translator-shell-v3-2");
  await old.put("/index.html", new Response("old shell"));
  await w.lifecycle("install");
  const current = await w.caches.open(CACHE);
  await current.put("/index.html", new Response("cached shell"));
  assert.equal(await (await w.request("/", { mode: "navigate" })).text(), "network shell");
  for (const failure of ["offline", "unavailable"]) {
    mode = failure;
    for (const url of ["/", "/index.html", "/?standalone=1", "/index.html?standalone=1"]) {
      assert.equal(await (await w.request(url, { mode: "navigate" })).text(), "network shell");
    }
  }
  mode = "offline";
  w.stores.get(CACHE).delete("https://unit.test/index.html");
  assert.equal((await w.request("/", { mode: "navigate" })).type, "error");
});

test("private, unknown, cross-origin, non-GET and other-version requests bypass the worker", () => {
  const w = worker(async () => { throw new Error("must not fetch"); });
  for (const url of ["/api/config", "/api/replay", "/audio/1", "/history", "/history/1", "/app.js", "/app.js?v=old", "/app.js?v=" + version + "&extra=1", "https://other.test/app.js?v=" + version]) {
    assert.equal(w.request(url), undefined, url);
  }
  assert.equal(w.request("/api/history", { mode: "navigate" }), undefined);
  assert.equal(w.request("/app.js?v=" + version, { method: "POST" }), undefined);
  assert.equal(w.calls.length, 0);
});

test("Express serves versioned shell URLs and revalidates HTML and the service worker", async t => {
  const f = await fixture(); t.after(() => f.close());
  for (const url of [...SHELL, "/sw.js"]) {
    const response = await f.request(url);
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get("cache-control"), /(?:no-cache|no-store|max-age=0)(?:,|$)/, url);
    assert.doesNotMatch(response.headers.get("cache-control"), /immutable/, url);
    const file = new URL(url, f.url).pathname;
    const expected = fs.readFileSync(path.join(root, "public", file === "/" ? "index.html" : file.slice(1)));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, url);
  }
  assert.equal((await (await f.request("/api/config")).json()).appVersion, version);
});

test("a failed cache write still delivers the successful network response", async () => {
  const w = worker(async () => new Response("network"));
  await w.lifecycle("install");
  w.stores.get(CACHE).delete("https://unit.test/app.js?v=" + version);
  w.quotaFull = true;
  assert.equal(await (await w.request("/app.js?v=" + version)).text(), "network");
  assert.equal(await (await w.request("/", { mode: "navigate" })).text(), "network");
});
