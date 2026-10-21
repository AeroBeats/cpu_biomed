/* 站点账号与会话 · 自建部署
   Qoder Sites 上由平台网关注入 x-qoder-user-context 判定身份；自建服务器没有这个网关，
   改为自己管账号：口令以 scrypt 散列入库，登录成功后发一枚 HMAC 签名的 HttpOnly Cookie。

   管理员不是数据库里注册出来的，而是 .env 里的 ADMIN_USER / ADMIN_PASSWORD：
   启动时把它同步进 app_users（role=admin），所以改口令只要改 .env 再重启，不会把自己锁在外面。
   普通用户走注册，role=user，只能同步自己的学习进度。

   会话是无状态的：Cookie 里只有 user_id 和过期时间，签名密钥不落库。
   角色每次请求都回库查一遍，所以撤掉某个账号的权限立即生效，不必等 Cookie 过期。 */

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'cp_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;

const b64u = (input) => Buffer.from(input).toString('base64url');
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest();

// 先各自散列再比较，这样两边长度一定相等，timingSafeEqual 才不会抛异常。
function safeEqual(a, b) {
  const ha = sha256(String(a));
  const hb = sha256(String(b));
  return timingSafeEqual(ha, hb);
}

export function newUserId() {
  return 'u_' + randomBytes(9).toString('hex');
}

export function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16);
    scrypt(String(password), salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, key) => {
      if (err) return reject(err);
      resolve(`scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${b64u(salt)}$${b64u(key)}`);
    });
  });
}

export function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    const parts = typeof stored === 'string' ? stored.split('$') : [];
    if (parts.length !== 6 || parts[0] !== 'scrypt') return resolve(false);
    // 只接受本文件写出的那组参数：散列串里的 N/r/p 若可任意指定，
    // 就等于让调用方决定这次校验要吃掉多少内存。
    if (parts[1] !== String(SCRYPT_N) || parts[2] !== String(SCRYPT_R) || parts[3] !== String(SCRYPT_P)) {
      return resolve(false);
    }
    let salt;
    let expected;
    try {
      salt = Buffer.from(parts[4], 'base64url');
      expected = Buffer.from(parts[5], 'base64url');
    } catch {
      return resolve(false);
    }
    if (!salt.length || expected.length !== KEYLEN) return resolve(false);
    scrypt(String(password), salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, key) => {
      resolve(!err && key.length === expected.length && timingSafeEqual(key, expected));
    });
  });
}

export function createAuth(env = process.env) {
  const adminName = typeof env.ADMIN_USER === 'string' ? env.ADMIN_USER.trim() : '';
  const adminPass = typeof env.ADMIN_PASSWORD === 'string' ? env.ADMIN_PASSWORD : '';
  // 口令没配好时一律拒绝发会话，绝不退化成「无认证」。
  const configured = adminName.length > 0 && adminPass.length >= 8 && !/\s/.test(adminName);
  const adminUsername = adminName.toLowerCase();

  // 没单独给 SESSION_SECRET 就从管理员口令派生：口令本身是 openssl rand 出来的高熵值，
  // 够用；代价是改口令会让所有人重新登录一次，这本来就是期望行为。
  const secret = (typeof env.SESSION_SECRET === 'string' && env.SESSION_SECRET.trim())
    ? sha256('cpubiomed.session.v1\n' + env.SESSION_SECRET.trim())
    : sha256('cpubiomed.session.v1\n' + adminPass);

  function sign(payload) {
    return b64u(createHmac('sha256', secret).update(payload).digest());
  }

  function parseBasic(header) {
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
    if (idx <= 0) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  }

  return {
    configured,
    adminUsername,
    adminDisplayName: adminName,
    adminPassword: adminPass,
    sessionTtlMs: SESSION_TTL_MS,

    /** 这个用户名留给 .env 管理员，注册时不能占用。 */
    isReserved(username) {
      return String(username).toLowerCase() === adminUsername;
    },

    /** curl / 安装脚本自检仍走 Basic，这里只负责解析，口令校验交给库里的散列。 */
    basicCredentials(headerValue) {
      return parseBasic(headerValue);
    },

    signSession(userId, now = Date.now()) {
      const payload = b64u(JSON.stringify({ u: String(userId), e: now + SESSION_TTL_MS }));
      return `s1.${payload}.${sign(payload)}`;
    },

    /** @returns {{userId:string,exp:number}|null} 签名不对、结构不对或已过期都返回 null。 */
    readSession(cookieValue) {
      if (typeof cookieValue !== 'string' || !cookieValue.startsWith('s1.')) return null;
      const parts = cookieValue.split('.');
      if (parts.length !== 3) return null;
      if (!safeEqual(sign(parts[1]), parts[2])) return null;
      let payload;
      try {
        payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (!payload || typeof payload.u !== 'string' || typeof payload.e !== 'number') return null;
      if (!(payload.e > Date.now())) return null;
      return { userId: payload.u, exp: payload.e };
    },

    cookieAttributes(secure) {
      return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
    },

    setCookieHeader(value, secure) {
      return `${SESSION_COOKIE}=${value}; ${this.cookieAttributes(secure)}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
    },

    clearCookieHeader(secure) {
      return `${SESSION_COOKIE}=; ${this.cookieAttributes(secure)}; Max-Age=0`;
    },

    /** 启动时把 .env 管理员落库，返回 'created' / 'synced' 供日志区分。 */
    async ensureAdmin(db) {
      if (!configured) throw new Error('ADMIN_USER / ADMIN_PASSWORD 未配置');
      const passHash = await hashPassword(adminPass);
      const now = new Date().toISOString();
      const existing = await db.findUserByUsername(adminUsername);
      if (!existing) {
        const inserted = await db.insertUser({
          user_id: newUserId(),
          username: adminUsername,
          pass_hash: passHash,
          role: 'admin',
          display_name: adminName,
          created_at: now,
          updated_at: now,
        });
        if (!inserted) throw new Error('管理员账号写入失败');
        return 'created';
      }
      if (existing.role !== 'admin') throw new Error(`用户名 ${adminUsername} 已被非管理员账号占用`);
      if (existing.pass_hash !== passHash) await db.setUserPassword(existing.user_id, passHash, now);
      return 'synced';
    },
  };
}
