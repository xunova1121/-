/** 仅容器内运行。主机不执行npm、项目脚本或归档中的程序。 */
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
const phase = process.argv[2];
const command = process.argv[3];
const run = (binary, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: '/work',
      env: {
        ...process.env,
        HOME: '/tmp',
        npm_config_cache: '/tmp/npm',
        npm_config_userconfig: '/tmp/npm-user.rc',
        npm_config_globalconfig: '/tmp/npm-global.rc',
        npm_config_audit: 'false',
        npm_config_fund: 'false'
      },
      stdio: 'inherit',
      shell: false
    });
    child.once('error', (error) => {
      if (error.code === 'ENOENT') {
        console.error('隔离镜像缺少' + binary + '，请管理员配置含Node、npm、tar、timeout的镜像');
        resolve(127);
      } else reject(error);
    });
    child.once('exit', (code) => resolve(code ?? 1));
  });
await fs.cp('/source', '/work', { recursive: true, dereference: false });
await fs.writeFile('/tmp/npm-user.rc', '');
await fs.writeFile('/tmp/npm-global.rc', '');
if (phase === 'install') {
  await fs.copyFile('/packages/lock.json', '/work/package-lock.json');
  const code = await run('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--strict-ssl=true']);
  if (code !== 0) process.exit(code);
  await fs.mkdir('/work/node_modules', { recursive: true });
  process.exit(await run('tar', ['-cf', '/output/deps.tar', '-C', '/work', 'node_modules']));
}
if (phase !== 'run' || !['lint', 'test'].includes(command)) throw new Error('隔离入口只支持install/lint/test');
const unpacked = await run('tar', ['-xf', '/deps.tar', '--no-same-owner', '-C', '/work']);
if (unpacked !== 0) process.exit(unpacked);
// 不运行pretest/posttest等隐含生命周期；明确要求的lint/test脚本照常执行。
process.exit(await run('npm', ['--ignore-scripts', 'run', command]));
