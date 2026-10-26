"use strict";
const { hashPassword, generatePassword, MIN_PASSWORD_LENGTH } = require("./passwords");
const { createSonioxUsage } = require("./soniox-usage");
const roles = ["admin", "user"];
function installAdminApi(app, { store, session, route, endUser, conversations, ownerUsername, prices, usageLogsUrl, apiKey }) {
  const denied = res => res.status(403).json({ error: "Prístup odmietnutý." });
  const invalid = res => res.status(400).json({ error: "Neplatné údaje alebo nepovolená zmena účtu." });
  const admin = (req, res, next) => {
    req.auth = session(req);
    if (req.auth?.role !== "admin") return denied(res);
    next();
  };
  app.use("/api/admin", admin);
  const body = (req, keys) => req.body && typeof req.body === "object" && !Array.isArray(req.body) && Object.keys(req.body).every(key => keys.includes(key));
  const limits = value => { try { if (value === undefined) return false; store.limitsJson(value); return true; } catch { return false; } };
  const password = value => value === undefined || (typeof value === "string" && value.length >= MIN_PASSWORD_LENGTH && value.length <= 512);
  const target = (req, res) => {
    const user = store.getUser(req.params.username);
    if (!user) res.status(404).json({ error: "Používateľ neexistuje." });
    return user;
  };
  function mutation(req, action, username, detail, fn) {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn(); store.audit(req.auth.username, action, username, detail);
      store.db.exec("COMMIT"); return result;
    } catch (err) { store.db.exec("ROLLBACK"); throw err; }
  }
  app.get("/api/admin/users", (_req, res) => res.json({ users: store.listUsers().map(u => ({
    username: u.username, role: u.role, disabled: Boolean(u.disabled_at), created_at: u.created_at, last_login_at: u.last_login_at, note: u.note,
    limits_override: JSON.parse(u.limits_json || "null"), limits_effective: store.limitsFor(u.username), today: store.read(u.username), month: store.monthUsage(u.username),
    active: [...conversations.values()].some(c => c.auth.username === u.username), sessions: store.userSessions(u.username),
    owner: u.username === ownerUsername, revoked: Boolean(u.disabled_at),
  })) }));
  app.post("/api/admin/users", route(async (req, res) => {
    if (!body(req, ["username", "role", "password", "limits", "note"])) return invalid(res);
    const { username, role, note, limits: override } = req.body;
    if (typeof username !== "string" || !/^[a-z0-9][a-z0-9._-]{1,39}$/.test(username) || !roles.includes(role) || !password(req.body.password) ||
        (note !== undefined && (typeof note !== "string" || note.length > 200)) || (override !== undefined && !limits(override))) return invalid(res);
    if (store.getUser(username)) return res.status(409).json({ error: "Používateľ už existuje." });
    const pw = req.body.password ?? generatePassword(), passwordHash = await hashPassword(pw);
    // Hashing yields: recheck authority and uniqueness before committing.
    req.auth = session(req); if (req.auth?.role !== "admin") return denied(res);
    if (store.getUser(username)) return res.status(409).json({ error: "Používateľ už existuje." });
    mutation(req, "create_user", username, { role, limits: override ?? null, note: note ?? null }, () => store.createUser({ username, role, passwordHash, limits: override, note }));
    res.status(201).json({ ok: true, username, password: pw });
  }));
  app.post("/api/admin/users/:username/password", route(async (req, res) => {
    if (!body(req, ["password"]) || !password(req.body.password)) return invalid(res);
    const user = target(req, res); if (!user) return;
    const pw = req.body.password ?? generatePassword(), hash = await hashPassword(pw);
    req.auth = session(req); if (req.auth?.role !== "admin") return denied(res);
    if (store.getUser(user.username)?.created_at !== user.created_at) return invalid(res);
    mutation(req, "reset_password", user.username, null, () => { store.setPasswordHash(user.username, hash); endUser(user.username); });
    res.json({ ok: true, username: user.username, password: pw });
  }));
  app.post("/api/admin/users/:username/limits", (req, res) => {
    if (!body(req, ["limits"]) || !limits(req.body.limits)) return invalid(res);
    const user = target(req, res); if (!user) return;
    mutation(req, "set_limits", user.username, { limits: req.body.limits }, () => store.setLimits(user.username, req.body.limits));
    res.json({ ok: true });
  });
  app.post("/api/admin/users/:username/role", (req, res) => {
    if (!body(req, ["role"]) || !roles.includes(req.body.role)) return invalid(res);
    const user = target(req, res); if (!user) return;
    const role = req.body.role;
    if (role === "user" && user.role === "admin" && (user.username === req.auth.username || (!user.disabled_at && store.countAdmins() <= 1))) return invalid(res);
    mutation(req, "set_role", user.username, { role }, () => store.setRole(user.username, role)); res.json({ ok: true });
  });
  for (const action of ["disable", "enable", "revoke", "logout", "delete"]) app.post("/api/admin/users/:username/" + action, (req, res) => {
    if (!body(req, [])) return invalid(res);
    const user = target(req, res); if (!user) return;
    const disable = action === "disable" || action === "revoke", remove = action === "delete";
    if ((disable || remove) && (user.username === req.auth.username || (user.role === "admin" && !user.disabled_at && store.countAdmins() <= 1))) return invalid(res);
    mutation(req, (disable ? "disable" : action) + "_user", user.username, null, () => {
      if (disable || remove || action === "logout") endUser(user.username);
      if (disable || action === "enable") store.setDisabled(user.username, disable);
      if (remove) store.deleteUser(user.username);
    });
    res.json({ ok: true, username: user.username });
  });
  function integer(value, fallback, max) {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || Number(value) > max) return null;
    return Number(value);
  }
  app.get("/api/admin/usage", (req, res) => {
    const days = integer(req.query.days, 30, 400), username = req.query.username;
    if (!days || (username !== undefined && (typeof username !== "string" || !username || username.length > 40))) return invalid(res);
    const to = store.day(), from = new Date(Date.parse(to + "T00:00:00Z") - (days - 1) * 86400000).toISOString().slice(0, 10);
    res.json(store.analyzeUsage(from, to, username, prices));
  });
  app.get("/api/admin/audit", (req, res) => {
    const limit = integer(req.query.limit, 100, 500); if (!limit) return invalid(res);
    res.json({ audit: store.listAudit(limit) });
  });
  const sonioxUsage = createSonioxUsage({ url: usageLogsUrl, apiKey });
  app.get("/api/admin/soniox-usage", route(async (_req, res) => {
    try { res.json(await sonioxUsage()); }
    catch { res.status(503).json({ error: "Spotreba Soniox momentálne nie je dostupná." }); }
  }));
}
module.exports = { installAdminApi };
