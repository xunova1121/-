"""正式发布前验证APK完整性和原证书；兼容Android build-tools新旧输出。"""
import os
import pathlib
import re
import subprocess
import sys

EXPECTED = '56e3579b63f41dc9d3f083b2e10bcdad40ded5503f520fa23413870964e363d6'


def check_certificate(report):
    # 新版叫“V2 Signer”，旧版叫“Signer #1”；仅匹配证书，排除公钥摘要。
    digests = re.findall(r'(?mi)^[^\r\n]*\bcertificate SHA-256 digest:[ \t]*([a-f0-9]{64})[ \t]*$', report)
    if not digests or {value.lower() for value in digests} != {EXPECTED}:
        raise ValueError('APK没有沿用原签名证书，停止正式发布；不得改用临时签名升级')


def main():
    tools = list(pathlib.Path(os.environ['ANDROID_HOME']).glob('build-tools/*/apksigner'))
    if not tools:
        raise SystemExit('未找到Android签名校验工具，停止正式发布')
    signer = max(tools, key=lambda p: tuple(map(int, re.findall(r'\d+', p.parent.name))))
    # 非零状态直接失败，不能以解析到正确证书掩盖损坏或未签名APK。
    report = subprocess.check_output([str(signer), 'verify', '--verbose', '--print-certs', sys.argv[1]], text=True)
    print(report)
    check_certificate(report)


if __name__ == '__main__':
    main()
