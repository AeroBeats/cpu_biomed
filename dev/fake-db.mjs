// Local fixture only: an in-memory stand-in for the supabase-js query chain.
// Enforces the real column set and NOT NULL columns so payload bugs surface here.
// Never packaged: lives in dev/, outside webDirectory and functionDirectory.

const SCHEMA = {
  questions: {
    columns: ['id', 'subject', 'chapter', 'qtype', 'level', 'tags', 'stem', 'opts',
      'answer', 'explain_text', 'source', 'built_in', 'sort_order', 'created_at', 'updated_at'],
    nullable: ['source'],
  },
  syllabus_chapters: {
    columns: ['id', 'subject', 'name', 'weight', 'points', 'sort_order', 'built_in',
      'created_at', 'updated_at'],
    nullable: [],
  },
  cards: {
    columns: ['id', 'subject', 'chapter', 'front', 'back', 'sort_order', 'built_in',
      'created_at', 'updated_at'],
    nullable: [],
  },
  site_settings: {
    columns: ['id', 'owner_id', 'updated_at'],
    nullable: [],
  },
};

export class FixtureError extends Error {}

class Query {
  constructor(store, table) {
    if (!SCHEMA[table]) throw new FixtureError(`unknown table ${table}`);
    this.store = store;
    this.table = table;
    this.mode = null;
    this.repr = false;
    this.cols = null;
    this.payload = null;
    this.filters = [];
    this.orders = [];
    this.limitN = null;
    this.failNext = null;
  }

  select(cols) {
    if (this.mode === null) { this.mode = 'select'; this.cols = cols; }
    else { this.repr = true; this.cols = cols; }
    return this;
  }

  insert(payload) { this.mode = 'insert'; this.payload = payload; return this; }
  update(payload) { this.mode = 'update'; this.payload = payload; return this; }
  delete() { this.mode = 'delete'; return this; }
  eq(col, val) { this.filters.push(['eq', col, val]); return this; }
  in(col, vals) { this.filters.push(['in', col, vals]); return this; }
  order(col, opts) { this.orders.push([col, !!(opts && opts.ascending)]); return this; }
  limit(n) { this.limitN = n; return this; }

  // Test hook: force the next provider round-trip to fail.
  failWith(error) { this.failNext = error; return this; }

  then(resolve, reject) {
    try { resolve(this.run()); } catch (e) { reject(e); }
  }

  run() {
    if (this.failNext) return { data: null, error: this.failNext };
    const rows = this.store[this.table];
    if (this.mode === 'select') {
      let out = rows.filter((row) => this.matches(row));
      out = this.sort(out);
      if (this.limitN !== null) out = out.slice(0, this.limitN);
      return { data: out.map((row) => this.project(row)), error: null };
    }
    if (this.mode === 'insert') {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const item of items) {
        for (const col of Object.keys(item)) {
          if (!SCHEMA[this.table].columns.includes(col)) {
            return { data: null, error: { code: '42703', message: `unknown column ${col}` } };
          }
        }
        for (const col of SCHEMA[this.table].columns) {
          const value = item[col];
          if ((value === undefined || value === null) && !SCHEMA[this.table].nullable.includes(col)) {
            return { data: null, error: { code: '23502', message: `null in ${col}` } };
          }
        }
        if (rows.some((row) => row.id === item.id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        rows.push(structuredClone(item));
      }
      return this.result(items.map((item) => item.id));
    }
    if (this.mode === 'update') {
      for (const col of Object.keys(this.payload)) {
        if (!SCHEMA[this.table].columns.includes(col)) {
          return { data: null, error: { code: '42703', message: `unknown column ${col}` } };
        }
      }
      const hit = rows.filter((row) => this.matches(row));
      const touched = [];
      for (const row of hit) {
        Object.assign(row, structuredClone(this.payload));
        touched.push(row.id);
      }
      return this.result(touched);
    }
    if (this.mode === 'delete') {
      const keep = [];
      const removed = [];
      for (const row of rows) {
        if (this.matches(row)) removed.push(row); else keep.push(row);
      }
      this.store[this.table].length = 0;
      this.store[this.table].push(...keep);
      // PostgREST returns the deleted rows for return=representation.
      return this.result(removed.map((row) => row.id), removed);
    }
    return { data: null, error: { code: '42601', message: 'no operation' } };
  }

  result(ids, source) {
    if (!this.repr) return { data: null, error: null };
    const wanted = this.cols ? this.cols.split(',').map((c) => c.trim()) : null;
    const rows = (source || this.store[this.table]).filter((row) => ids.includes(row.id));
    return { data: rows.map((row) => (wanted ? this.project(row, wanted) : row)), error: null };
  }

  project(row, wanted) {
    const cols = wanted || (this.cols ? this.cols.split(',').map((c) => c.trim()) : null);
    if (!cols) return structuredClone(row);
    const out = {};
    for (const col of cols) {
      if (!SCHEMA[this.table].columns.includes(col)) {
        throw new FixtureError(`select of unknown column ${col} on ${this.table}`);
      }
      out[col] = row[col] === undefined ? null : structuredClone(row[col]);
    }
    return out;
  }

  matches(row) {
    return this.filters.every(([op, col, val]) => {
      if (!SCHEMA[this.table].columns.includes(col)) throw new FixtureError(`filter on unknown column ${col}`);
      if (op === 'eq') return row[col] === val;
      return Array.isArray(val) && val.includes(row[col]);
    });
  }

  sort(rows) {
    if (!this.orders.length) return rows;
    return rows.slice().sort((a, b) => {
      for (const [col, asc] of this.orders) {
        const x = a[col]; const y = b[col];
        if (x === y) continue;
        const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return asc ? cmp : -cmp;
      }
      return 0;
    });
  }
}

export function createFakeSupabase(seed = {}) {
  const store = {};
  for (const table of Object.keys(SCHEMA)) store[table] = structuredClone(seed[table] || []);
  const client = {
    from(table) { return new Query(store, table); },
    __store: store,
  };
  return client;
}
