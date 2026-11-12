"use strict";
// Consistent copy of the SQLite database (accounts, passkeys, audit, usage) next to it in backups/.
// On Fly: fly ssh console -C "node /app/backup-db.js", then fly ssh sftp get <printed path>. Keeps the newest 7 copies.
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs"), path = require("node:path");

function backup(source = process.env.USAGE_DB_PATH || "/data/usage.sqlite", keep = 7) {
  if (!fs.existsSync(source)) throw new Error("Database not found: " + source);
  const dir = path.join(path.dirname(source), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "usage-" + new Date().toISOString().replace(/[:.]/g, "-") + ".sqlite");
  const db = new DatabaseSync(source);
  // VACUUM INTO writes a complete, consistent copy even while the app keeps writing (WAL mode).
  try { db.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'"); } finally { db.close(); }
  const old = fs.readdirSync(dir).filter(n => /^usage-.*\.sqlite$/.test(n)).sort().slice(0, -keep);
  for (const name of old) fs.unlinkSync(path.join(dir, name));
  return file;
}
if (require.main === module) {
  try { console.log(backup()); } catch (err) { console.error("Backup failed: " + err.message); process.exitCode = 1; }
}
module.exports = { backup };
