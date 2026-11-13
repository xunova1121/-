#!/usr/bin/env python3
"""本地直接发布原安装包，不调用Actions，不构建，不读取用户应用配置。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = 'xunova1121/weiyang-release'
API = f'https://api.github.com/repos/{REPOSITORY}'


class StopPublish(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None


def require(value, message):
    if not value:
        raise StopPublish(message)


def digest(path, algorithm='sha256'):
    hasher = hashlib.new(algorithm)
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher


def request_json(token, url, method='GET', body=None, file=None):
    parsed = urllib.parse.urlparse(url)
    require(parsed.scheme == 'https' and parsed.hostname in ('api.github.com', 'uploads.github.com')
            and not parsed.port and not parsed.username and not parsed.password,
            '拒绝向非官方地址发送发布凭据')
    require(parsed.path.startswith(f'/repos/{REPOSITORY}/releases'), '上传路径不属于指定发布仓库')
    headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
               'User-Agent': 'weiyang-direct-release', 'X-GitHub-Api-Version': '2022-11-28'}
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    if data is not None:
        headers['Content-Type'] = 'application/json'
    stream = None
    if file is not None:
        headers['Content-Type'] = 'application/octet-stream'
        headers['Content-Length'] = str(file.stat().st_size)
        stream = file.open('rb')
        data = stream
    try:
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.build_opener(NoRedirect).open(req, timeout=180) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # 只输出固定诊断码，绝不打印请求头、令牌、原始响应或重定向地址。
        labels = {401: '发布授权未通过', 403: '权限或访问限制', 404: '资源不可访问',
                  422: '发布或附件冲突', 429: '接口限流'}
        reason = labels.get(error.code, 'GitHub请求失败')
        raise StopPublish(f'{parsed.hostname} HTTP {error.code}：{reason}；停止发布，保留已有文件') from None
    except urllib.error.URLError:
        raise StopPublish(f'{parsed.hostname} 连接未完成；停止发布，保留已有文件') from None
    finally:
        if stream:
            stream.close()


def validate_local(directory):
    manifest = json.loads((directory / 'manual-release-files.json').read_text())
    version = manifest['version']
    require(re.fullmatch(r'1\.0\.\d{1,6}', version), '版本不正确')
    names = {f'Jarvis-{version}-android.apk', f'Jarvis-{version}-win-x64.zip',
             f'Jarvis-Setup-{version}.exe', f'Jarvis-Setup-{version}.exe.blockmap',
             f'jarvis-server-{version}.tar.gz', 'jarvis-server-latest.json', 'latest.yml'}
    assets = manifest['assets']
    require(len(assets) == 7 and {a['name'] for a in assets} == names, '必须提供指定7份安装文件')
    require(re.fullmatch(r'[a-f0-9]{40}', manifest['sourceCommit']), '缺少构建来源')
    for asset in assets:
        file = directory / asset['name']
        require(not file.is_symlink() and file.is_file(), f'文件缺失：{asset["name"]}')
        require(file.stat().st_size == asset['bytes'] and digest(file).hexdigest() == asset['sha256'],
                f'文件大小或摘要不一致：{asset["name"]}')
    server = json.loads((directory / 'jarvis-server-latest.json').read_text())
    require(server['version'] == version and server['file'] == f'jarvis-server-{version}.tar.gz'
            and server['sha256'] == next(a['sha256'] for a in assets if a['name'] == server['file']),
            '服务器更新清单不一致')
    import base64
    windows = (directory / 'latest.yml').read_text()
    hashes = re.findall(r'sha512:\s*([^\s]+)', windows)
    expected = base64.b64encode(digest(directory / f'Jarvis-Setup-{version}.exe', 'sha512').digest()).decode()
    require(f'version: {version}\n' in windows and f'Jarvis-Setup-{version}.exe' in windows
            and hashes and all(item == expected for item in hashes), 'Windows更新清单不一致')
    return manifest


def matches(actual, expected):
    return actual and actual.get('state') == 'uploaded' and actual['size'] == expected['bytes'] \
        and actual.get('digest') == 'sha256:' + expected['sha256']


def publish(directory, token):
    manifest = validate_local(directory)
    version = manifest['version']
    tag = 'desktop-v' + version
    notes = (directory / 'manual-release-notes.md').read_text()
    notes = re.sub(r'^下载状态：.*\n\n?', '', notes, flags=re.M)
    print(f'{version}：三端7份本地文件及更新清单核对一致；未构建、未运行测试', flush=True)
    latest = request_json(token, API + '/releases/latest')
    require(re.fullmatch(r'desktop-v1\.0\.\d+', latest['tag_name'])
            and int(latest['tag_name'].split('.')[-1]) <= int(version.split('.')[-1]), '不能回退公开最新版本')
    releases = request_json(token, API + '/releases?per_page=100')
    target = next((release for release in releases if release['tag_name'] == tag), None)
    if target is None:
        target = request_json(token, API + '/releases', 'POST',
                              {'tag_name': tag, 'name': '未央 ' + version, 'body': notes, 'draft': True})
    require(all(a['name'] in {item['name'] for item in manifest['assets']} for a in target['assets']),
            '目标发布有未知附件，停止覆盖')
    upload = target['upload_url'].split('{', 1)[0]
    require(upload == f'https://uploads.github.com/repos/{REPOSITORY}/releases/{target["id"]}/assets',
            'GitHub返回的上传入口不符合预期')
    # 小文件先传，鉴权失败立即停止，避免先传几百MB；已完成的相同原包可继续复用。
    for asset in sorted(manifest['assets'], key=lambda item: item['bytes']):
        existing = next((a for a in target['assets'] if a['name'] == asset['name']), None)
        if existing:
            require(matches(existing, asset), f'目标已有不同文件，停止覆盖：{asset["name"]}')
            continue
        require(target['draft'], '正式发布缺少附件，停止修改')
        url = upload + '?' + urllib.parse.urlencode({'name': asset['name']})
        uploaded = request_json(token, url, 'POST', file=directory / asset['name'])
        require(matches(uploaded, asset), f'上传回执摘要不符：{asset["name"]}')
        print(f'已上传：{asset["name"]}', flush=True)
    target_url = API + f'/releases/{target["id"]}'
    target = request_json(token, target_url)
    require(len(target['assets']) == 7 and all(matches(next((a for a in target['assets'] if a['name'] == item['name']), None), item)
                                                for item in manifest['assets']), '公开附件尚未齐全，保留草稿')
    request_json(token, target_url, 'PATCH', {'draft': False, 'prerelease': False,
                                           'make_latest': 'true', 'name': '未央 ' + version, 'body': notes})
    latest = request_json(token, API + '/releases/latest')
    require(latest['tag_name'] == tag and not latest['draft'], '尚未确认公开最新版本')
    receipt = {'tag': tag, 'url': latest['html_url'], 'assets': [a['name'] for a in latest['assets']],
               'published': True, 'actionsUsed': False, 'testsRerun': False}
    (directory / 'direct-publish-receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    print('公开发布完成：' + latest['html_url'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    args = parser.parse_args()
    try:
        # 可由任务环境的安全密钥配置提供；不从命令参数/仓库/应用配置中找密钥。
        credential = os.environ.get('WEIYANG_RELEASE_TOKEN') or os.environ.get('GH_TOKEN')
        require(credential and credential.strip(), '需在安全环境变量中配置WEIYANG_RELEASE_TOKEN或现有GH_TOKEN')
        publish(args.directory.resolve(), credential.strip())
    except StopPublish as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, TypeError):
        print('本地文件或发布元数据不符合预期；未确认发布完成', file=sys.stderr)
        sys.exit(1)
