import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

const expected = '56e3579b63f41dc9d3f083b2e10bcdad40ded5503f520fa23413870964e363d6';
const python = report => spawnSync('python3', ['-c', `import runpy,sys,json\nscope=runpy.run_path('scripts/check-apk-signature.py')\nscope['check_certificate'](json.loads(sys.argv[1]))`, JSON.stringify(report)], { encoding: 'utf8' });

describe('实际Android build-tools签名输出格式', () => {
  it.each(['Signer #1', 'V2 Signer', 'V3.1 Signer'])('%s证书原值相同即通过，不依赖旧前缀', prefix => {
    const result = python(`${prefix}: certificate SHA-256 digest: ${expected}\n${prefix}: public key SHA-256 digest: ${'b'.repeat(64)}\n`);
    expect(result.status, result.stderr).toBe(0);
  });
  it('只匹配公钥不能代替证书；无证书和错误证书均拒绝', () => {
    for (const report of ['', `V2 Signer: public key SHA-256 digest: ${expected}`, `V2 Signer: certificate SHA-256 digest: ${'a'.repeat(64)}`]) expect(python(report).status).not.toBe(0);
  });
  it('所有签名证书必须一致，多签名中混入别的证书仍拒绝', () => {
    expect(python(`Signer #1 certificate SHA-256 digest: ${expected}\nSigner #2 certificate SHA-256 digest: ${'c'.repeat(64)}\n`).status).not.toBe(0);
  });
  it('apksigner完整性校验失败时，即使输出带正确证书也不能通过', () => {
    const script = `import os,pathlib,runpy,subprocess,sys\nos.environ['ANDROID_HOME']='/fixture'\npathlib.Path.glob=lambda self,pattern:[pathlib.Path('/fixture/build-tools/36.0.0/apksigner')]\ndef broken(*a,**k):\n raise subprocess.CalledProcessError(1,a[0],output='Signer #1 certificate SHA-256 digest: ${expected}')\nsubprocess.check_output=broken\nsys.argv=['check-apk-signature.py','fixture.apk']\nrunpy.run_path('scripts/check-apk-signature.py',run_name='__main__')`;
    const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('CalledProcessError');
  });
});
