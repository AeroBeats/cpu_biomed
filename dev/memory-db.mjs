// 内存版数据层替身，接口与 deploy/server/db.mjs 的 wrap() 一致。
// 仅用于本地跑接口逻辑，不需要安装 pg，也不需要真的 Postgres。
import { SELECT_COLUMNS, MAX_READ_ROWS } from '../deploy/server/db.mjs';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function createMemoryDb() {
  const tables = { questions: new Map(), syllabus_chapters: new Map(), cards: new Map() };
  let owner = null;

  const need = (table) => {
    const found = tables[table];
    if (!found) throw new Error('unknown_table:' + table);
    return found;
  };

  return {
    _tables: tables,
    _owner: () => owner,

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

    async getOwner() { return owner ? { id: 'owner', owner_id: owner } : null; },

    async claimOwner(ownerId) {
      if (owner === null) owner = ownerId;
      return owner;
    },
  };
}
