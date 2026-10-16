/* 站点访问认证 · 自建部署
   Qoder Sites 上由平台网关注入 x-qoder-user-context 判定所有者；自建服务器上没有这个网关，
   改用 HTTP Basic：整站（页面 + 接口）共用一组口令，浏览器首次访问时弹窗输入一次。
   身份只有一个，因此 owner_id 固定为 'admin'，改口令或改用户名都不会把自己锁在外面。 */

import { createHash, timingSafeEqual } from 'node:crypto';

const REALM = 'Basic realm="cpu-biomed", charset="UTF-8"';
const OWNER_ID = 'admin';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest();

function safeEqual(a, b) {
  const ha = sha256(a);
  const hb = sha256(b);
  return ha.length === hb.length && timingSafeEqual(ha, hb);
}

export function createAuth(env = process.env) {
  const user = typeof env.ADMIN_USER === 'string' ? env.ADMIN_USER : '';
  const pass = typeof env.ADMIN_PASSWORD === 'string' ? env.ADMIN_PASSWORD : '';
  // 口令没配好时一律拒绝，绝不退化成「无认证」。
  const configured = user.length > 0 && pass.length >= 8 && !/\s/.test(user);

  function parse(header) {
    if (typeof header !== 'string') return null;
    const m = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/.exec(header.trim());
    if (!m) return null;
    let decoded;
    try {
      decoded = Buffer.from(m[1], 'base64').toString('utf8');
    } catch {
      return null;
    }
    const idx = decoded.indexOf(':');
    if (idx <= 0 || idx === -1) return null;
    return { name: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  }

  return {
    configured,
    OWNER_ID,
    /** @returns {{user_id:string,name:string}|null} */
    getUser(headerValue) {
      if (!configured) return null;
      const cred = parse(headerValue);
      if (!cred) return null;
      if (!safeEqual(cred.name, user) || !safeEqual(cred.pass, pass)) return null;
      return { user_id: OWNER_ID, name: cred.name };
    },
    challengeHeaders() {
      return { 'WWW-Authenticate': REALM };
    },
  };
}
