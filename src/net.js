// Outbound network policy for upstream model APIs.
// Mirrors Vault's NetworkPolicy: HTTPS only, no credentials in URL, and every
// resolved address must be public (blocks SSRF into loopback / private ranges).
import dns from 'node:dns';
import net from 'node:net';

const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'home', 'home.arpa'];

export function isPublicIp(address) {
  let ip = address;
  if (net.isIPv6(ip) && ip.toLowerCase().startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    const b = ip.split('.').map(Number);
    return !(b[0] === 0 || b[0] === 10 || b[0] === 127 || b[0] >= 224 ||
      (b[0] === 100 && b[1] >= 64 && b[1] <= 127) ||
      (b[0] === 169 && b[1] === 254) ||
      (b[0] === 172 && b[1] >= 16 && b[1] <= 31) ||
      (b[0] === 192 && (b[1] === 168 || (b[1] === 0 && (b[2] === 0 || b[2] === 2)) || (b[1] === 88 && b[2] === 99))) ||
      (b[0] === 198 && (b[1] === 18 || b[1] === 19 || (b[1] === 51 && b[2] === 100))) ||
      (b[0] === 203 && b[1] === 0 && b[2] === 113));
  }
  if (!net.isIPv6(ip)) return false;
  const bytes = ipv6Bytes(ip);
  if (!bytes || (bytes[0] & 0xe0) !== 0x20) return false; // only 2000::/3 global unicast
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false; // 6to4
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2] < 2 || (bytes[2] === 0x0d && bytes[3] === 0xb8))) return false;
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0) return false;
  return true;
}

function ipv6Bytes(ip) {
  const [head, tail = ''] = ip.split('::');
  const parse = (part) => (part ? part.split(':') : []);
  let left = parse(head);
  let right = ip.includes('::') ? parse(tail) : [];
  const last = (right.length ? right : left).at(-1);
  if (last && last.includes('.')) return null; // embedded IPv4 forms are not needed here
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (!ip.includes('::') && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  const out = [];
  for (const g of groups) {
    const v = parseInt(g, 16);
    if (Number.isNaN(v) || v > 0xffff) return null;
    out.push(v >> 8, v & 0xff);
  }
  return out;
}

// allowQuery/allowHttp are only used for downloading generated images.
export function validateBaseUrl(value, { allowQuery = false, allowHttp = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\s\\\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('接口地址无效');
  }
  const authority = value.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0];
  if (authority.includes('@')) throw new Error('接口地址不能包含账号信息');
  let url;
  try { url = new URL(value); } catch { throw new Error('接口地址无效'); }
  const protocolOk = url.protocol === 'https:' || (allowHttp && url.protocol === 'http:');
  if (!protocolOk || url.username || url.password || (url.search && !allowQuery) || (url.hash && !allowQuery)) {
    throw new Error('接口地址必须是公开 HTTPS 地址');
  }
  url.hash = '';
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new Error('不允许访问服务器本机或非公网地址');
  } else if (!host.includes('.') || LOCAL_SUFFIXES.some((s) => host === s || host.endsWith('.' + s))) {
    throw new Error('不允许访问本地地址');
  }
  return url;
}

// dns.lookup-compatible function that refuses non-public results.
export function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = typeof options === 'number' ? { family: options } : { ...options };
  dns.lookup(hostname, { ...opts, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some((a) => !isPublicIp(a.address))) {
      const err = new Error('目标解析到了非公网地址');
      err.code = 'NON_PUBLIC_ADDRESS';
      return callback(err);
    }
    if (opts.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}
