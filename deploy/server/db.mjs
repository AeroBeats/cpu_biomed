/* PostgreSQL 数据层
   表名与列名全部来自下面的白名单常量，绝不取自请求内容；值一律走参数占位符。
   jsonb 列必须显式 JSON.stringify —— node-pg 会把数组当成 Postgres 数组字面量序列化。 */

export const MAX_READ_ROWS = 5000;
const TABLES = {
  questions: {
    columns: ['id', 'subject', 'chapter', 'qtype', 'level', 'tags', 'stem', 'opts', 'answer',
      'explain_text', 'source', 'built_in', 'sort_order', 'created_at', 'updated_at'],
    select: 'id,subject,chapter,qtype,level,tags,stem,opts,answer,explain_text,source,built_in,sort_order',
    jsonb: ['tags', 'opts', 'answer'],
  },
  syllabus_chapters: {
    columns: ['id', 'subject', 'name', 'weight', 'points', 'sort_order', 'built_in', 'created_at', 'updated_at'],
    select: 'id,subject,name,weight,points,sort_order,built_in',
    jsonb: ['points'],
  },
  cards: {
    columns: ['id', 'subject', 'chapter', 'front', 'back', 'sort_order', 'built_in', 'created_at', 'updated_at'],
    select: 'id,subject,chapter,front,back,sort_order,built_in',
    jsonb: [],
  },
};

// 测试替身（dev/memory-db.mjs）共用这份列定义，避免两边漂移。
export const SELECT_COLUMNS = Object.fromEntries(
  Object.entries(TABLES).map(([table, spec]) => [table, spec.select.split(',')]),
);

// 账号表的列固定且短，不走上面的内容表白名单：它没有 sort_order / built_in 这套约定。
const USER_SELECT = 'user_id, username, pass_hash, role, display_name';

function spec(table) {
  const found = TABLES[table];
  if (!found) throw new Error('unknown_table');
  return found;
}

function encode(table, row) {
  const { columns, jsonb } = spec(table);
  const keys = Object.keys(row);
  for (const key of keys) {
    if (!columns.includes(key)) throw new Error('unknown_column:' + key);
  }
  return keys.map((key) => {
    const value = row[key];
    if (value === undefined) return null;
    return jsonb.includes(key) ? JSON.stringify(value) : value;
  });
}

// 驱动按需加载：本地跑接口测试时不需要装 pg。
export async function createDb(connectionString) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    // 连接被云厂商或防火墙掐断时快速失败，而不是让请求挂住。
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  return wrap(pool);
}

export function wrap(pool) {
  const query = (text, values) => pool.query(text, values);

  return {
    async ping() {
      await query('SELECT 1');
    },

    async close() {
      if (typeof pool.end === 'function') await pool.end();
    },

    async list(table) {
      const { select } = spec(table);
      const { rows } = await query(
        `SELECT ${select} FROM ${table} ORDER BY sort_order ASC, id ASC LIMIT $1`, [MAX_READ_ROWS]);
      return rows;
    },

    async count(table) {
      spec(table);
      const { rows } = await query(`SELECT count(*)::int AS n FROM ${table}`);
      return rows[0].n;
    },

    async findMeta(table, id) {
      spec(table);
      const { rows } = await query(
        `SELECT built_in, sort_order FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
      return rows[0] || null;
    },

    // 插入用 ON CONFLICT DO NOTHING，并发下同 id 的第二个写入方拿到 duplicate 而不是覆盖。
    async insertOne(table, row) {
      spec(table);
      const keys = Object.keys(row);
      const values = encode(table, row);
      const placeholders = keys.map((_, i) => '$' + (i + 1)).join(', ');
      const { rowCount, rows } = await query(
        `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})
         ON CONFLICT (id) DO NOTHING RETURNING id`, values);
      return { inserted: rowCount > 0, id: rows[0] ? rows[0].id : null };
    },

    async insertMany(table, rows) {
      spec(table);
      let inserted = 0;
      for (const row of rows) {
        const result = await this.insertOne(table, row);
        if (result.inserted) inserted += 1;
      }
      return inserted;
    },

    async updateOne(table, id, fields) {
      spec(table);
      const keys = Object.keys(fields);
      const values = encode(table, fields);
      const sets = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');
      const { rowCount } = await query(
        `UPDATE ${table} SET ${sets} WHERE id = $${keys.length + 1} RETURNING id`,
        [...values, id]);
      return rowCount > 0;
    },

    async deleteOne(table, id) {
      spec(table);
      const { rowCount } = await query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [id]);
      return rowCount > 0;
    },

    async existingIds(table, ids) {
      spec(table);
      if (!ids.length) return new Set();
      const { rows } = await query(`SELECT id FROM ${table} WHERE id = ANY($1::text[])`, [ids]);
      return new Set(rows.map((row) => row.id));
    },

    /* ---- 账号与进度 ----
       用户名一律存小写，由 auth 层在写入和查询前归一化。 */

    async findUserByUsername(username) {
      const { rows } = await query(
        `SELECT ${USER_SELECT} FROM app_users WHERE username = $1 LIMIT 1`, [username]);
      return rows[0] || null;
    },

    async findUser(userId) {
      const { rows } = await query(
        `SELECT ${USER_SELECT} FROM app_users WHERE user_id = $1 LIMIT 1`, [userId]);
      return rows[0] || null;
    },

    // 用户名撞车时 ON CONFLICT DO NOTHING 返回 0 行，调用方据此报 username_taken。
    async insertUser(row) {
      const { rowCount } = await query(
        `INSERT INTO app_users (user_id, username, pass_hash, role, display_name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [row.user_id, row.username, row.pass_hash, row.role, row.display_name, row.created_at, row.updated_at]);
      return rowCount > 0;
    },

    async setUserPassword(userId, passHash, now) {
      const { rowCount } = await query(
        'UPDATE app_users SET pass_hash = $1, updated_at = $2 WHERE user_id = $3',
        [passHash, now, userId]);
      return rowCount > 0;
    },

    async deleteUser(userId) {
      // user_progress 级联删掉，invite_codes.used_by 置 NULL（码保持「已用」状态）。
      const { rowCount } = await query(
        'DELETE FROM app_users WHERE user_id = $1 RETURNING user_id', [userId]);
      return rowCount > 0;
    },

    /* ---- 注册邀请码 ----
       码一律大写存储，归一化由 validate.mjs 负责，这里只按精确值查。 */

    async findInvite(code) {
      const { rows } = await query(
        'SELECT code, used_at FROM invite_codes WHERE code = $1 LIMIT 1', [code]);
      return rows[0] || null;
    },

    // 条件更新保证一人一码：并发下第二个写入方拿到 0 行，不会把同码发给两个人。
    // 条件用 used_at 而不是 used_by：删账号会把 used_by 置空，但码不该因此复活。
    async claimInvite(code, userId, now) {
      const { rowCount } = await query(
        `UPDATE invite_codes SET used_by = $2, used_at = $3
         WHERE code = $1 AND used_at IS NULL RETURNING code`,
        [code, userId, now]);
      return rowCount > 0;
    },

    async insertInvite(row) {
      const { rowCount } = await query(
        `INSERT INTO invite_codes (code, note, created_by, created_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING code`,
        [row.code, row.note, row.created_by, row.created_at]);
      return rowCount > 0;
    },

    // used_by 换成用户名再回给界面，一串 uuid 对管理员没有意义。
    async listInvites(limit) {
      const { rows } = await query(
        `SELECT i.code, i.note, i.created_at, i.used_at, u.username AS used_by
         FROM invite_codes i LEFT JOIN app_users u ON u.user_id = i.used_by
         ORDER BY i.created_at DESC, i.code DESC LIMIT $1`, [limit]);
      return rows;
    },

    async deleteInvite(code) {
      const { rowCount } = await query(
        'DELETE FROM invite_codes WHERE code = $1 RETURNING code', [code]);
      return rowCount > 0;
    },

    async getProgress(userId) {
      const { rows } = await query(
        'SELECT data, updated_at FROM user_progress WHERE user_id = $1 LIMIT 1', [userId]);
      return rows[0] || null;
    },

    async putProgress(userId, data, now) {
      const { rowCount } = await query(
        `INSERT INTO user_progress (user_id, data, updated_at) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [userId, JSON.stringify(data), now]);
      return rowCount > 0;
    },
  };
}
