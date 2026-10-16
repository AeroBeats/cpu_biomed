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

const OWNER_ROW = 'owner';

// 测试替身（dev/memory-db.mjs）共用这份列定义，避免两边漂移。
export const SELECT_COLUMNS = Object.fromEntries(
  Object.entries(TABLES).map(([table, spec]) => [table, spec.select.split(',')]),
);

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

    async getOwner() {
      const { rows } = await query(
        'SELECT id, owner_id FROM site_settings WHERE id = $1 LIMIT 1', [OWNER_ROW]);
      return rows[0] || null;
    },

    // 返回实际生效的 owner_id：并发抢占时以库里那一条为准。
    async claimOwner(ownerId, now) {
      await query(
        `INSERT INTO site_settings (id, owner_id, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`, [OWNER_ROW, ownerId, now]);
      const row = await this.getOwner();
      return row ? row.owner_id : null;
    },
  };
}
