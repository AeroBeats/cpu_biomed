/* 图片存储 · 只服务于后台「插入配图」这一个场景
   文件落在 MEDIA_DIR 下，按 <年月>/<随机名>.<扩展名> 存放。扩展名由服务端按文件头判定，
   完全不用上传方给的文件名，所以不存在路径穿越，也不会有双扩展名之类的花招。
   图片不进数据库：题库内容里只留一条 ![](/media/…) 的相对路径，图本身是静态文件。 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError } from './validate.mjs';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
// base64 每 3 字节变 4 字符，先按长度粗筛，省得为一张 50 MB 的图先解码再拒绝。
const MAX_B64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URL_RE = /^data:[a-z0-9!#$&^_.+-]*\/[a-z0-9!#$&^_.+-]*;base64,/i;

// 只收这几种位图。**SVG 明确排除**：它是 XML，能内嵌 <script> 和外部实体，
// 而 /media/ 与站点同源，收进来就等于给管理员账号留了一个持久化 XSS 的位置。
const SIGNATURES = [
  {
    ext: 'png',
    test: (b) => b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  { ext: 'jpg', test: (b) => b.length > 10 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: 'gif',
    test: (b) => b.length > 10
      && (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a'),
  },
  {
    ext: 'webp',
    test: (b) => b.length > 16 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  },
];

export function detectImage(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const hit = SIGNATURES.find((s) => s.test(buffer));
  return hit ? hit.ext : null;
}

function stripDataUrl(value) {
  if (typeof value !== 'string') throw new AppError('invalid_field', 400, 'data');
  const text = value.trim();
  const withoutPrefix = text.replace(DATA_URL_RE, '');
  if (withoutPrefix.length > MAX_B64_CHARS) throw new AppError('image_too_large', 413, 'data');
  if (!B64_RE.test(withoutPrefix)) throw new AppError('invalid_field', 400, 'data');
  return Buffer.from(withoutPrefix, 'base64');
}

export function createMediaStore(root) {
  const dir = path.resolve(root);
  let ensured = null;
  const ensureDir = (target) => (ensured ??= mkdir(dir, { recursive: true })).then(() => mkdir(target, { recursive: true }));

  /** 校验并落盘一段 base64，返回站内可直接引用的相对路径（形如 /media/202610/ab12….png）。 */
  async function save(base64) {
    const buffer = stripDataUrl(base64);
    if (!buffer.length) throw new AppError('invalid_field', 400, 'data');
    if (buffer.length > MAX_IMAGE_BYTES) throw new AppError('image_too_large', 413, 'data');
    const ext = detectImage(buffer);
    if (!ext) throw new AppError('unsupported_image', 415, 'data');

    const now = new Date();
    const bucket = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const name = `${randomBytes(12).toString('hex')}.${ext}`;
    await ensureDir(path.join(dir, bucket));
    await writeFile(path.join(dir, bucket, name), buffer, { mode: 0o644 });
    return `/media/${bucket}/${name}`;
  }

  /** 把 /media/… 的 URL 路径解析成磁盘路径；越界、目录、隐藏文件一律返回 null。 */
  function resolve(urlPath) {
    let rel;
    try { rel = decodeURIComponent(urlPath); } catch { return null; }
    if (rel.indexOf('\u0000') !== -1) return null;
    const target = path.resolve(dir, '.' + path.posix.normalize(rel.replace(/^\/+/, '/')));
    if (target !== dir && !target.startsWith(dir + path.sep)) return null;
    if (path.basename(target).startsWith('.')) return null;
    // 只发图片：即使别的文件被误放进这个目录，也不会经这里流出去。
    return detectImageExt(target) ? target : null;
  }

  return { dir, save, resolve };
}

function detectImageExt(file) {
  return /\.(png|jpe?g|gif|webp)$/i.test(file);
}
