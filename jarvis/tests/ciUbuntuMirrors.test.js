import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform === 'win32')('CI 直接使用官方 Ubuntu 仓库，保留安全源、第三方源和 apt 参数', () => {
  const rules = fileURLToPath(new URL('../scripts/ci-ubuntu-mirrors.sed', import.meta.url));
  const archive = 'https://archive.ubuntu.com/ubuntu/';
  const cases = [
    ['URIs: mirror+file:/etc/apt/apt-mirrors.txt', 'URIs: ' + archive],
    ['deb mirror+file:///etc/apt/apt-mirrors.txt noble-updates main', 'deb ' + archive + ' noble-updates main'],
    ['http://us-east-2.ec2.archive.ubuntu.com/ubuntu/ priority:1', archive + ' priority:1'],
    ['deb https://azure.archive.ubuntu.com/ubuntu noble main', 'deb ' + archive + ' noble main'],
    ['URIs: mirror+file:/etc/apt/apt-mirrors-security.txt'],
    ['https://security.ubuntu.com/ubuntu/'],
    ['deb https://packages.microsoft.com/ubuntu/24.04/prod noble main'],
    ['Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg']
  ];
  const expected = cases.map(([source, result]) => result || source).join('\n') + '\n';
  const dir = mkdtempSync(join(tmpdir(), 'weiyang-apt-'));
  try {
    const file = join(dir, 'ubuntu.sources');
    writeFileSync(file, cases.map(([source]) => source).join('\n') + '\n');
    for (let run = 0; run < 2; run++) {
      execFileSync('sed', ['-E', '-i.bak', '-f', rules, file], { stdio: 'ignore', timeout: 5000 });
      expect(readFileSync(file, 'utf8')).toBe(expected);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
