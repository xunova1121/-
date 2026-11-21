// 仅测试用：让网关把 *.test 域名解析到本机（模拟一个“公网”的中转接口）
import dns from 'node:dns';
const orig = dns.lookup;
dns.lookup = function (host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (/\.test$/.test(host)) return opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
  return orig.call(this, host, opts, cb);
};
