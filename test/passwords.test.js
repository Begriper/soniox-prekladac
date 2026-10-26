const test = require("node:test"), assert = require("node:assert/strict");
const { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword, generatePassword } = require("../passwords");
test("scrypt passwords use random salts and fixed parameters and reject wrong or malformed hashes", async () => {
  assert.equal(MIN_PASSWORD_LENGTH, 12);
  await assert.rejects(hashPassword("short"));
  const password = "long password with spaces ", hash = await hashPassword(password);
  assert.match(hash, /^scrypt\$16384\$8\$1\$[\w-]{22}\$[\w-]{86}$/);
  assert.notEqual(await hashPassword(password), hash);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(password.trim(), hash), false);
  for (const value of [null, "", "scrypt$999999999$8$1$salt$hash", hash.slice(0, -1), hash.replace("$8$", "$9$")]) assert.equal(await verifyPassword(password, value), false);
  assert.equal(await verifyPassword(null, hash), false);
});
test("generated passwords contain 16 unambiguous random characters", () => {
  const passwords = Array.from({ length: 50 }, generatePassword);
  assert.equal(new Set(passwords).size, passwords.length);
  for (const pw of passwords) { assert.match(pw, /^[A-Za-z2-9]{16}$/); assert.doesNotMatch(pw, /[0O1lI]/); }
});
