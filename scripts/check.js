const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
for (const dir of ['.', 'public', 'test', 'scripts']) {
  for (const name of readdirSync(dir).filter(n => n.endsWith('.js') || n.endsWith('.cjs'))) {
    const file = dir + '/' + name;
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr || file); process.exitCode = 1; }
  }
}
