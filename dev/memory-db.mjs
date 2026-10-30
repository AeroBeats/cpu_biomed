// 内存版数据层替身，接口与 deploy/server/db.mjs 的 wrap() 一致。
// 仅用于本地跑接口逻辑，不需要安装 pg，也不需要真的 Postgres。
import { SELECT_COLUMNS, MAX_READ_ROWS } from '../deploy/server/db.mjs';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// 真库只 SELECT 这五列，替身也照着裁剪，避免测试里用到实际拿不到的字段。
const USER_COLS = ['user_id', 'username', 'pass_hash', 'role', 'display_name'];
const publicUser = (row) => {
  const out = {};
  USER_COLS.forEach((c) => { out[c] = row[c]; });
  return out;
};

export function createMemoryDb() {
  const tables = { questions: new Map(), syllabus_chapters: new Map(), cards: new Map() };
  const users = new Map();      // user_id -> row
  const byName = new Map();     // username -> user_id
  const progress = new Map();   // user_id -> { data, updated_at }
  const invites = new Map();    // code -> { code, note, created_by, created_at, used_by, used_at }

  const need = (table) => {
    const found = tables[table];
    if (!found) throw new Error('unknown_table:' + table);
    return found;
  };

  return {
    _tables: tables,
    _users: users,
    _progress: progress,
    _invites: invites,

    async ping() {},
    async close() {},

    async list(table) {
      const cols = SELECT_COLUMNS[table];
      return [...need(table).values()]
        .sort((a, b) => (a.sort_order - b.sort_order) || String(a.id).localeCompare(String(b.id)))
        .slice(0, MAX_READ_ROWS)
        .map((row) => {
          const out = {};
          for (const c of cols) out[c] = clone(row[c]);
          return out;
        });
    },

    async count(table) { return need(table).size; },

    async findMeta(table, id) {
      const row = need(table).get(id);
      return row ? { built_in: row.built_in, sort_order: row.sort_order } : null;
    },

    async insertOne(table, row) {
      const found = need(table);
      if (found.has(row.id)) return { inserted: false, id: null };
      found.set(row.id, clone(row));
      return { inserted: true, id: row.id };
    },

    async insertMany(table, rows) {
      let inserted = 0;
      for (const row of rows) {
        const r = await this.insertOne(table, row);
        if (r.inserted) inserted += 1;
      }
      return inserted;
    },

    async updateOne(table, id, fields) {
      const found = need(table);
      const row = found.get(id);
      if (!row) return false;
      for (const [k, v] of Object.entries(fields)) row[k] = clone(v);
      return true;
    },

    async deleteOne(table, id) { return need(table).delete(id); },

    async existingIds(table, ids) {
      const found = need(table);
      return new Set(ids.filter((id) => found.has(id)));
    },

    async findUserByUsername(username) {
      const id = byName.get(username);
      const row = id ? users.get(id) : null;
      return row ? publicUser(row) : null;
    },

    async findUser(userId) {
      const row = users.get(userId);
      return row ? publicUser(row) : null;
    },

    async insertUser(row) {
      if (byName.has(row.username) || users.has(row.user_id)) return false;
      const stored = clone(row);
      users.set(stored.user_id, stored);
      byName.set(stored.username, stored.user_id);
      return true;
    },

    async setUserPassword(userId, passHash, now) {
      const row = users.get(userId);
      if (!row) return false;
      row.pass_hash = passHash;
      row.updated_at = now;
      return true;
    },

    // 照搬外键行为：进度级联删，邀请码只把 used_by 置空（码保持已用）。
    async deleteUser(userId) {
      const row = users.get(userId);
      if (!row) return false;
      users.delete(userId);
      byName.delete(row.username);
      progress.delete(userId);
      invites.forEach((inv) => { if (inv.used_by === userId) { inv.used_by = null; } });
      return true;
    },

    async findInvite(code) {
      const row = invites.get(code);
      // 真库只 SELECT code 和 used_at，替身也照样裁剪。
      return row ? { code: row.code, used_at: row.used_at } : null;
    },

    async claimInvite(code, userId, now) {
      const row = invites.get(code);
      // 与真库同一条 WHERE：看 used_at，删账号留下的空 used_by 不能让码复活。
      if (!row || row.used_at) return false;
      row.used_by = userId;
      row.used_at = now;
      return true;
    },

    async insertInvite(row) {
      if (invites.has(row.code)) return false;
      invites.set(row.code, {
        code: row.code, note: row.note, created_by: row.created_by,
        created_at: row.created_at, used_by: null, used_at: null,
      });
      return true;
    },

    async listInvites(limit) {
      const rows = [...invites.values()]
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.code.localeCompare(a.code))
        .slice(0, limit)
        .map((row) => {
          const user = row.used_by ? users.get(row.used_by) : null;
          return {
            code: row.code, note: row.note, created_at: row.created_at,
            used_at: row.used_at, used_by: user ? user.username : null,
          };
        });
      return rows;
    },

    async deleteInvite(code) {
      return invites.delete(code);
    },

    async getProgress(userId) {
      const row = progress.get(userId);
      return row ? { data: clone(row.data), updated_at: row.updated_at } : null;
    },

    async putProgress(userId, data, now) {
      if (!users.has(userId)) return false;
      progress.set(userId, { data: clone(data), updated_at: now });
      return true;
    },
  };
}
