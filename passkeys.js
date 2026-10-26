"use strict";
const crypto = require("node:crypto");
const { parseCookies, equal, clientIp, WindowLimiter } = require("./security");
const COOKIE = "sl_webauthn", TTL = 5 * 60000;
const sha256 = value => crypto.createHash("sha256").update(value).digest();
function decode(value, max = 4096) {
  if (typeof value !== "string" || !value.length || value.length > max || !/^[\w-]+$/.test(value)) throw new Error("Invalid encoding");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("Invalid encoding");
  return bytes;
}
function installPasskeyApi(app, { store, requireSession, finishLogin, origins, secret, production, env }) {
  const rpId = new URL([...origins][0]).hostname, rpHash = sha256(rpId);
  const challenges = new Map();
  const rate = new WindowLimiter(Number(env.MAX_LOGIN_ATTEMPTS || 8), 600000), globalRate = new WindowLimiter(100, 600000, 1);
  const sign = id => crypto.createHmac("sha256", secret).update("webauthn:" + id).digest("base64url");
  const cookie = (value, age) => COOKIE + "=" + value + "; Path=/api/passkeys/login; HttpOnly; SameSite=Strict; Max-Age=" + age + (production ? "; Secure" : "");
  const invalid = res => res.status(400).json({ error: "Overenie zlyhalo. Skús znova alebo použi meno a heslo." });
  function limited(req, res, next) {
    if (!rate.allow(clientIp(req, env.TRUST_FLY_PROXY === "true" && Boolean(env.FLY_APP_NAME))) || !globalRate.allow("all")) return res.status(429).json({ error: "Príliš veľa pokusov. Skús neskôr." });
    next();
  }
  function issue(key) {
    for (const [id, state] of challenges) if (state.expires <= Date.now()) challenges.delete(id);
    // Bound anonymous state even if options are requested without completing a ceremony.
    if (!challenges.has(key) && challenges.size >= 4096) throw new Error("Challenge capacity");
    const challenge = crypto.randomBytes(32).toString("base64url");
    challenges.set(key, { challenge, expires: Date.now() + TTL });
    return challenge;
  }
  function take(key) {
    const state = challenges.get(key); challenges.delete(key);
    if (!state || state.expires <= Date.now()) throw new Error("Expired challenge");
    return state;
  }
  function loginKey(req) {
    const value = parseCookies(req.headers.cookie)[COOKIE] || "";
    if (!/^[\w-]{43}\.[\w-]{43}$/.test(value)) return "";
    const [id, signature] = value.split(".");
    return equal(sign(id), signature) ? "login:" + id : "";
  }
  function verify(body, state, type) {
    if (!body || body.type !== "public-key" || body.id !== body.rawId) throw new Error("Invalid credential");
    decode(body.id, 1366);
    const clientBytes = decode(body.response?.clientDataJSON), client = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clientBytes));
    if (client.type !== type || client.challenge !== state.challenge || !origins.has(client.origin) || client.topOrigin !== undefined || (client.crossOrigin !== undefined && client.crossOrigin !== false)) throw new Error("Invalid client data");
    const auth = decode(body.response.authenticatorData);
    if (auth.length < 37 || !crypto.timingSafeEqual(auth.subarray(0, 32), rpHash) || (auth[32] & 5) !== 5 || ((auth[32] & 16) && !(auth[32] & 8))) throw new Error("Invalid authenticator data");
    return { auth, clientBytes, count: auth.readUInt32BE(33) };
  }
  function transaction(fn) {
    store.db.exec("BEGIN IMMEDIATE");
    try { fn(); store.db.exec("COMMIT"); }
    catch (err) { store.db.exec("ROLLBACK"); throw err; }
  }
  app.post("/api/passkeys/register/options", requireSession, (req, res) => {
    if (store.passkeys(req.auth.username).length >= 10) return res.status(400).json({ error: "Účet má najviac 10 prístupových kľúčov. Najprv niektorý odstráň." });
    const challenge = issue("register:" + req.auth.id), user = store.getUser(req.auth.username);
    res.json({ challenge, rp: { id: rpId, name: "Prekladač" }, user: { id: user.webauthn_user_id, name: user.username, displayName: user.username },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required", authenticatorAttachment: "platform" }, attestation: "none",
      excludeCredentials: store.passkeys(user.username).map(p => ({ type: "public-key", id: p.id })), timeout: 60000 });
  });
  app.post("/api/passkeys/register", requireSession, (req, res) => {
    let data, key, state;
    try { state = take("register:" + req.auth.id); } catch { return invalid(res); }
    const response = req.body?.response;
    if (!response?.publicKey || !response?.authenticatorData || !Number.isInteger(response?.publicKeyAlgorithm)) return res.status(400).json({ error: "Prehliadač neposkytuje verejný kľúč. Aktualizuj ho alebo použi meno a heslo." });
    try {
      data = verify(req.body, state, "webauthn.create");
      if (!(data.auth[32] & 64) || ![-7, -257].includes(response.publicKeyAlgorithm)) throw new Error("Invalid registration");
      decode(response.attestationObject);
      key = crypto.createPublicKey({ key: decode(response.publicKey), format: "der", type: "spki" });
      if (response.publicKeyAlgorithm === -7 ? key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1" : key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength < 2048) throw new Error("Invalid key type");
      if (response.transports !== undefined && (!Array.isArray(response.transports) || response.transports.length > 8 || response.transports.some(t => typeof t !== "string" || t.length > 30))) throw new Error("Invalid transports");
      if (store.getPasskey(req.body.id) || store.passkeys(req.auth.username).length >= 10) throw new Error("Credential unavailable");
    } catch { return invalid(res); }
    const label = (typeof req.body.label === "string" && req.body.label.trim() ? req.body.label.trim() : req.headers["user-agent"] || "Zariadenie").slice(0, 60);
    transaction(() => {
      store.statement("INSERT INTO passkeys(id,username,public_key,alg,sign_count,transports,label,created_at) VALUES(?,?,?,?,?,?,?,?)").run(req.body.id, req.auth.username, key.export({ type: "spki", format: "der" }).toString("base64url"), response.publicKeyAlgorithm, data.count, JSON.stringify(response.transports || []), label, new Date().toISOString());
      store.audit(req.auth.username, "register_passkey", req.auth.username);
    });
    res.json({ ok: true });
  });
  app.post("/api/passkeys/login/options", limited, (req, res) => {
    challenges.delete(loginKey(req));
    const id = crypto.randomBytes(32).toString("base64url"), challenge = issue("login:" + id);
    res.setHeader("Set-Cookie", cookie(id + "." + sign(id), TTL / 1000));
    res.json({ challenge, rpId, userVerification: "required", timeout: 60000, allowCredentials: [] });
  });
  app.post("/api/passkeys/login", limited, (req, res) => {
    res.append("Set-Cookie", cookie("", 0));
    let credential, user, data;
    try {
      const state = take(loginKey(req));
      data = verify(req.body, state, "webauthn.get");
      credential = store.getPasskey(req.body.id);
      if (!credential) return res.status(401).json({ error: "Prihlásenie sa nepodarilo. Použi meno a heslo.", code: "unknown_credential" });
      user = store.getUser(credential.username);
      if (!user || user.disabled_at || !equal(decode(req.body.response.userHandle).toString("base64url"), user.webauthn_user_id)) throw new Error("Invalid user");
      const key = crypto.createPublicKey({ key: decode(credential.public_key), format: "der", type: "spki" });
      const options = credential.alg === -7 ? { key, dsaEncoding: "der" } : { key, padding: crypto.constants.RSA_PKCS1_PADDING };
      if (![-7, -257].includes(credential.alg) || !crypto.verify("sha256", Buffer.concat([data.auth, sha256(data.clientBytes)]), options, decode(req.body.response.signature))) throw new Error("Invalid signature");
      // Platform passkeys may always report 0; once a counter was seen, any non-increase (including 0) is a clone signal.
      if (credential.sign_count && data.count <= credential.sign_count) throw new Error("Invalid counter");
    } catch { return invalid(res); }
    finishLogin(req, res, user, "passkey_login", () => store.statement("UPDATE passkeys SET sign_count=?,last_used_at=? WHERE id=?").run(data.count, new Date().toISOString(), credential.id));
  });
  app.get("/api/passkeys", requireSession, (req, res) => res.json({ passkeys: store.passkeys(req.auth.username) }));
  app.post("/api/passkeys/:id/delete", requireSession, (req, res) => {
    if (store.getPasskey(req.params.id)?.username !== req.auth.username) return res.status(404).json({ error: "Prístupový kľúč sa nenašiel." });
    transaction(() => {
      store.statement("DELETE FROM passkeys WHERE id=? AND username=?").run(req.params.id, req.auth.username);
      store.audit(req.auth.username, "delete_passkey", req.auth.username);
    });
    res.json({ ok: true });
  });
}
module.exports = { installPasskeyApi };
