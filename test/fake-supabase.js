// Stands in for Supabase: the PostgREST subset api/index.js uses, plus
// /auth/v1/user. Real HTTP, so the server under test runs its own fetch code
// unchanged; only SUPABASE_URL points here.
import http from 'node:http';
import crypto from 'node:crypto';

const DEFAULTS = {
  organisers: () => ({ email: '' }),
  trips: () => ({ name: '', currency: 'EUR', home_currency: 'USD', rate: 1, pass: 'free' }),
  trip_invites: () => ({ revoked_at: null }),
  trip_people: () => ({ name: '', from_date: null, to_date: null, pay_handle: '', sort_index: 0 }),
  trip_days: () => ({ city: '', note: '', sort_index: 0 }),
  trip_items: () => ({ at_time: '', title: '', detail: '', place: '', lat: null, lng: null, category: 'activity', booked: false, author: '', sort_index: 0 }),
  trip_expenses: () => ({ item_id: null, spent_on: null, description: '', amount_cents: 0, currency: 'EUR', paid_by: null, shared_with: [], author: '' }),
  trip_receipts: () => ({ person_id: null, ok: false }),
};
const KEY = { trip_invites: 'token' };

export function startFake({ port = 0, users = {} } = {}) {
  const db = Object.fromEntries(Object.keys(DEFAULTS).map((t) => [t, []]));
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const now = () => new Date(clock++).toISOString();
  const log = [];

  const matches = (row, filters) => filters.every(([col, op, val]) => {
    const v = row[col];
    if (op === 'eq') return String(v) === val;
    if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').includes(String(v));
    if (op === 'is') return val === 'null' ? v == null : String(v) === val;
    throw new Error('fake: unsupported op ' + op);
  });

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
      const u = new URL(req.url, 'http://x');

      if (u.pathname === '/auth/v1/user') {
        const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
        return users[tok] ? send(200, users[tok]) : send(401, { msg: 'bad jwt' });
      }
      const m = u.pathname.match(/^\/rest\/v1\/(\w+)$/);
      if (!m || !db[m[1]]) return send(404, { message: 'no table' });
      if (req.headers.apikey !== 'service-key') return send(401, { message: 'no key' });
      const table = m[1], rows = db[table];
      log.push(req.method + ' ' + table + u.search);

      const filters = [];
      let order = null, onConflict = null;
      for (const [k, v] of u.searchParams) {
        if (k === 'select' || k === 'limit') continue;
        if (k === 'order') { order = v.split(',').map((s) => s.split('.')); continue; }
        if (k === 'on_conflict') { onConflict = v; continue; }
        const dot = v.indexOf('.');
        filters.push([k, v.slice(0, dot), v.slice(dot + 1)]);
      }
      const body = raw ? JSON.parse(raw) : null;
      const prefer = String(req.headers.prefer || '');
      const out = (list) => (prefer.includes('return=minimal') ? send(201) : send(200, list));

      if (req.method === 'GET') {
        let list = rows.filter((r) => matches(r, filters));
        if (order) {
          list = list.slice().sort((a, b) => {
            for (const [col, dir] of order) {
              const x = a[col] ?? '', y = b[col] ?? '';
              if (x < y) return dir === 'desc' ? 1 : -1;
              if (x > y) return dir === 'desc' ? -1 : 1;
            }
            return 0;
          });
        }
        return send(200, list.map((r) => structuredClone(r)));
      }
      if (req.method === 'POST') {
        const made = [];
        for (const input of Array.isArray(body) ? body : [body]) {
          if (onConflict) {
            const hit = rows.find((r) => r[onConflict] === input[onConflict]);
            if (hit) { Object.assign(hit, input); made.push(hit); continue; }
          }
          const key = KEY[table] || 'id';
          if (key !== 'id' && rows.some((r) => r[key] === input[key])) return send(409, { message: 'duplicate key' });
          const row = { id: crypto.randomUUID(), ...DEFAULTS[table](), created_at: now(), ...structuredClone(input) };
          if (table === 'trip_items' || table === 'trip_expenses') row.updated_at = row.updated_at || row.created_at;
          rows.push(row); made.push(row);
        }
        return out(made.map((r) => structuredClone(r)));
      }
      if (req.method === 'PATCH') {
        if (!filters.length) return send(400, { message: 'refusing an unfiltered update' });
        const hit = rows.filter((r) => matches(r, filters));
        for (const r of hit) Object.assign(r, structuredClone(body));
        return out(hit.map((r) => structuredClone(r)));
      }
      if (req.method === 'DELETE') {
        if (!filters.length) return send(400, { message: 'refusing an unfiltered delete' });
        const gone = rows.filter((r) => matches(r, filters));
        db[table] = rows.filter((r) => !gone.includes(r));
        return out(gone);
      }
      send(405, {});
    });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, db: () => db, log, close: () => server.close() });
  }));
}
