"use strict";
const { scrypt, randomBytes, randomInt, timingSafeEqual } = require("node:crypto");
const MIN_PASSWORD_LENGTH = 12;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const derive = (pw, salt) => new Promise((resolve, reject) => scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => err ? reject(err) : resolve(key)));
async function hashPassword(pw) {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD_LENGTH) throw new Error("Password must contain at least 12 characters");
  const salt = randomBytes(16), hash = await derive(pw, salt);
  return "scrypt$16384$8$1$" + salt.toString("base64url") + "$" + hash.toString("base64url");
}
async function verifyPassword(pw, stored) {
  if (typeof pw !== "string" || typeof stored !== "string") return false;
  // Only accept our fixed work factor and canonical encodings, never DB-supplied costs.
  const match = /^scrypt\$16384\$8\$1\$([\w-]{22})\$([\w-]{86})$/.exec(stored);
  if (!match) return false;
  const salt = Buffer.from(match[1], "base64url"), expected = Buffer.from(match[2], "base64url");
  if (salt.toString("base64url") !== match[1] || expected.toString("base64url") !== match[2]) return false;
  return timingSafeEqual(await derive(pw, salt), expected);
}
function generatePassword() { return Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""); }
module.exports = { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword, generatePassword };
