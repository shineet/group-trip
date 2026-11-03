// Local server: the static pages plus /api, the way Vercel serves them.
//
//   node dev/serve.js            uses a stand-in database with a demo trip
//   SUPABASE_URL=... node dev/serve.js   uses a real project (.env values)
//
// Prints a guest link for the demo trip. The stand-in also accepts the
// organiser token "demo-organiser" in place of a real sign-in.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFake } from '../test/fake-supabase.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 8420);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

// A Vercel-shaped response, so api/index.js runs here exactly as deployed.
function shim(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
  return res;
}

export async function serve({ port = PORT, seed = true, quiet = false } = {}) {
  let fake = null;
  if (!process.env.SUPABASE_URL) {
    fake = await startFake({ users: {
      'demo-organiser': { id: '00000000-0000-4000-8000-000000000001', email: 'organiser@example.com' },
      'other-organiser': { id: '00000000-0000-4000-8000-000000000002', email: 'someone@example.com' },
    } });
    process.env.SUPABASE_URL = fake.url;
    process.env.SUPABASE_SECRET_KEY = 'service-key';
  }
  const { default: handler } = await import('../api/index.js');

  const server = http.createServer((req, res) => {
    shim(res);
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api' || u.pathname === '/api/index') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        req.body = raw;
        handler(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'dev server' }); });
      });
      return;
    }
    // cleanUrls, as in vercel.json: /trip serves trip.html.
    let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/index.html';
    if (!path.extname(p)) p += '.html';
    const full = path.join(ROOT, p);
    if (!full.startsWith(ROOT + path.sep) || !fs.existsSync(full)) {
      res.status(404).end('not found'); return;
    }
    res.setHeader('Content-Type', TYPES[path.extname(full)] || 'application/octet-stream');
    res.end(fs.readFileSync(full));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let demo = null;
  if (fake && seed) demo = await seedDemo(base);
  if (!quiet) {
    console.log(`Trip app on ${base}`);
    if (demo) console.log(`Demo trip, as a guest: ${base}/trip#${demo.token}`);
  }
  return { base, fake, demo, close: () => { server.close(); fake && fake.close(); } };
}

export async function call(base, action, extra) {
  const r = await fetch(base + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function seedDemo(base) {
  const auth = 'demo-organiser';
  const { body } = await call(base, 'trip_create', {
    auth, name: 'Madrid & Barcelona', start_date: '2026-10-10', end_date: '2026-10-15',
    currency: 'EUR', home_currency: 'USD', rate: 1.08,
    people: ['Shine & Nadia', 'Ravi & Meera', 'Dan & Kate', 'Leo & Ana'],
  });
  const t = body.trip.token;
  const { body: trip } = await call(base, 'load', { t });
  const [d1, d2, , d4] = trip.days;
  const leo = trip.people[3];
  await call(base, 'person_save', { t, person: { id: leo.id, name: leo.name, from_date: '2026-10-12', to_date: '2026-10-15' } });
  for (const [day, city] of [[0, 'Madrid'], [1, 'Madrid'], [2, 'Madrid'], [3, 'Barcelona'], [4, 'Barcelona'], [5, 'Barcelona']]) {
    await call(base, 'day_save', { t, id: trip.days[day].id, city });
  }
  await call(base, 'item_save', { t, item: { day_id: d1.id, at_time: '11:40', title: 'Land at Barajas', place: 'Madrid Barajas Airport', category: 'travel', booked: true, author: 'Shine & Nadia' } });
  await call(base, 'item_save', { t, item: { day_id: d2.id, at_time: '09:30', title: 'Chocolatería San Ginés', place: 'Chocolatería San Ginés, Madrid', category: 'food', author: 'Ravi & Meera' } });
  await call(base, 'item_save', { t, item: { day_id: d2.id, at_time: '11:00', title: 'Prado Museum', detail: 'Timed entry, tickets on Ravi\'s phone', place: 'Museo del Prado', category: 'activity', booked: true, author: 'Ravi & Meera' } });
  await call(base, 'item_save', { t, item: { day_id: d4.id, at_time: '', title: 'Train to Barcelona', place: 'Madrid Atocha', category: 'travel', author: 'Dan & Kate' } });
  const [sn, rm, dk] = trip.people;
  await call(base, 'expense_save', { t, expense: { description: 'Prado tickets', amount_cents: 9000, currency: 'EUR', paid_by: rm.id, shared_with: [sn.id, rm.id, dk.id], spent_on: '2026-10-11', author: 'Ravi & Meera' } });
  await call(base, 'expense_save', { t, expense: { description: 'Barcelona apartment', amount_cents: 162000, currency: 'USD', paid_by: sn.id, shared_with: trip.people.map((p) => p.id), spent_on: '2026-10-13', author: 'Shine & Nadia' } });
  return { token: t, tripId: body.trip.id };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) serve();
