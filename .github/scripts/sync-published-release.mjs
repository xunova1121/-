// 仅同步已正式发布的原安装包；不构建、不改变版本或签名、不使用Actions产物存储。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sourceRepo = 'xunova1121/-';
const targetRepo = 'xunova1121/weiyang-release';
const tag = process.env.MIRROR_TAG || '';
const sourceToken = process.env.SOURCE_TOKEN;
const targetToken = process.env.RELEASE_REPO_TOKEN;

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

function github(token, args) {
  // 不打印凭据、请求头或完整环境；令牌仅通过进程环境传给官方CLI。
  try {
    return execFileSync('gh', args, {
      env: { ...process.env, GH_TOKEN: token },
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 180_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const status = String(error.stderr || '').match(/HTTP\s+(\d{3})/u)?.[1];
    throw new Error(`GitHub操作失败${status ? `（HTTP ${status}）` : ''}；未继续发布`, { cause: undefined });
  }
}

function api(token, path) {
  return JSON.parse(github(token, ['api', path]));
}

function fingerprint(file, algorithm = 'sha256') {
  return createHash(algorithm).update(readFileSync(file)).digest(algorithm === 'sha512' ? 'base64' : 'hex');
}

function sameAsset(actual, expected) {
  return actual?.state === 'uploaded' && actual.size === expected.size && actual.digest === expected.digest;
}

async function syncPublished() {
  requireState(/^desktop-v1\.0\.\d{1,6}$/u.test(tag), '版本标签格式不正确');
  requireState(sourceToken && targetToken, '缺少源码读取或公开仓库发布凭据；未发布');
  requireState(process.env.GITHUB_REPOSITORY === sourceRepo, '仅允许从指定源码仓库执行');
  const version = tag.slice('desktop-v'.length);
  const expectedNames = [
    `Jarvis-${version}-android.apk`, `Jarvis-${version}-win-x64.zip`,
    `Jarvis-Setup-${version}.exe`, `Jarvis-Setup-${version}.exe.blockmap`,
    `jarvis-server-${version}.tar.gz`, 'jarvis-server-latest.json', 'latest.yml',
  ];
  const source = api(sourceToken, `repos/${sourceRepo}/releases/tags/${tag}`);
  requireState(!source.draft && !source.prerelease && source.published_at, '只能同步已经正式发布的版本');
  requireState(source.assets.length === expectedNames.length, '原发布附件数量不符合预期');
  for (const name of expectedNames) {
    const asset = source.assets.find((item) => item.name === name);
    requireState(asset?.state === 'uploaded' && asset.size > 0 && /^sha256:[a-f0-9]{64}$/u.test(asset.digest), `原包不完整：${name}`);
  }
  const latest = api(targetToken, `repos/${targetRepo}/releases/latest`);
  requireState(/^desktop-v1\.0\.\d+$/u.test(latest.tag_name), '公开最新版本无法比较，停止防止回退');
  requireState(Number(latest.tag_name.split('.').at(-1)) <= Number(version.split('.').at(-1)), '不能把公开最新版本回退');
  const directory = mkdtempSync(join(tmpdir(), 'weiyang-release-sync-'));
  try {
    github(sourceToken, ['release', 'download', tag, '--repo', sourceRepo, '--dir', directory]);
    for (const asset of source.assets) {
      const file = join(directory, asset.name);
      requireState(readFileSync(file).length === asset.size && `sha256:${fingerprint(file)}` === asset.digest, `原包摘要不一致：${asset.name}`);
    }
    const server = JSON.parse(readFileSync(join(directory, 'jarvis-server-latest.json'), 'utf8'));
    requireState(server.version === version && server.sha256 === fingerprint(join(directory, `jarvis-server-${version}.tar.gz`)), '服务器更新清单不一致');
    const windows = readFileSync(join(directory, 'latest.yml'), 'utf8');
    requireState(windows.includes(`version: ${version}`) && windows.includes(`Jarvis-Setup-${version}.exe`), 'Windows更新清单版本不一致');
    const hashes = [...windows.matchAll(/sha512:\s*([^\s]+)/gu)].map((match) => match[1]);
    requireState(hashes.length > 0 && hashes.every((hash) => hash === fingerprint(join(directory, `Jarvis-Setup-${version}.exe`), 'sha512')), 'Windows安装包摘要不一致');

    // 元数据原样复用；去除上次仅描述“尚未同步”的过时状态，保留所有未测说明。
    const notes = join(directory, 'release-notes.md');
    writeFileSync(notes, String(source.body || '').replace(/^下载状态：.*\n\n?/mu, ''));
    let target = api(targetToken, `repos/${targetRepo}/releases?per_page=100`).find((item) => item.tag_name === tag);
    if (!target) {
      github(targetToken, ['release', 'create', tag, '--repo', targetRepo, '--draft', '--title', source.name, '--notes-file', notes]);
      target = api(targetToken, `repos/${targetRepo}/releases?per_page=100`).find((item) => item.tag_name === tag);
    }
    requireState(target, '找不到目标发布草稿');
    requireState(target.assets.every((asset) => expectedNames.includes(asset.name)), '目标发布包含未知附件，停止覆盖');
    for (const asset of source.assets) {
      const existing = target.assets.find((item) => item.name === asset.name);
      if (existing) {
        requireState(sameAsset(existing, asset), `目标已有不同安装包，停止覆盖：${asset.name}`);
        continue;
      }
      requireState(target.draft, '已公开版本缺少附件，停止修改');
      github(targetToken, ['release', 'upload', tag, join(directory, asset.name), '--repo', targetRepo]);
      console.log(`已上传：${asset.name}`);
    }
    target = api(targetToken, `repos/${targetRepo}/releases/${target.id}`);
    requireState(target.assets.length === expectedNames.length && source.assets.every((asset) => sameAsset(target.assets.find((item) => item.name === asset.name), asset)), '公开原包核对未通过，保留草稿');
    github(targetToken, ['release', 'edit', tag, '--repo', targetRepo, '--draft=false', '--prerelease=false', '--latest', '--title', source.name, '--notes-file', notes]);
    const published = api(targetToken, `repos/${targetRepo}/releases/latest`);
    requireState(published.tag_name === tag && !published.draft, '未确认公开最新版本，需核对');
    console.log(`已公开发布：${published.html_url}`);
    console.log('仅同步7份现有安装包；没有构建或运行测试。');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

syncPublished().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
