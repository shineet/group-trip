// The one server function. Every request names an action.
//
// Guests carry the trip's invite token and nothing else. The server turns that
// token into a trip id and adds the trip id to every read and write itself, so
// no request from a phone can name a row in somebody else's trip: an id from
// another trip simply matches nothing. Organisers carry a Supabase access
// token, checked against Supabase Auth on every call.
//
// One file rather than one per action: Vercel counts functions, and a router
// costs nothing.
import crypto from 'node:crypto';

const SB = () => process.env.SUPABASE_URL;
const HDR = (extra) => ({
  apikey: process.env.SUPABASE_SECRET_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
  'Content-Type': 'application/json',
  ...(extra || {}),
});

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// ── Database ────────────────────────────────────────────────────────────────
// Values in filters are encoded here and only here, so a name with a comma or
// an ampersand in it cannot change what a query means.
const q = (v) => encodeURIComponent(String(v));

async function rest(method, path, body, prefer) {
  const r = await fetch(`${SB()}/rest/v1/${path}`, {
    method,
    headers: HDR(prefer ? { Prefer: prefer } : body ? { Prefer: 'return=representation' } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error('supabase', method, path.split('?')[0], r.status, text.slice(0, 300));
    fail(502, 'The trip could not be saved right now. Try again in a moment.');
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}
const select = (path) => rest('GET', path);
const insert = (table, rows) => rest('POST', table, rows, 'return=representation');
const patch = (path, body) => rest('PATCH', path, body, 'return=representation');
const remove = (path) => rest('DELETE', path, undefined, 'return=representation');

// ── Shapes ──────────────────────────────────────────────────────────────────
// Only these columns are ever written from a request. trip_id is never one of
// them: it comes from the token, not from the phone.
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = new Set(['activity', 'plan', 'food', 'travel', 'stay', 'note']);
const CURRENCY = /^[A-Z]{3}$/;

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const isoOrNull = (v) => (ISO.test(String(v || '')) ? String(v) : null);
const idOrFail = (v) => (UUID.test(String(v || '')) ? String(v) : fail(400, 'Missing id.'));

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);

// ── Who is asking ───────────────────────────────────────────────────────────
async function tripFromToken(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) fail(401, 'That link does not work.');
  const rows = await select(`trip_invites?token=eq.${q(token)}&revoked_at=is.null&select=trip_id`);
  if (!rows || !rows[0]) fail(401, 'That link is out of date. Ask the organiser for a new one.');
  const trips = await select(`trips?id=eq.${q(rows[0].trip_id)}`);
  if (!trips || !trips[0]) fail(401, 'That trip no longer exists.');
  return trips[0];
}

async function organiserFromAuth(auth) {
  if (!auth || typeof auth !== 'string') fail(401, 'Sign in first.');
  const r = await fetch(`${SB()}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${auth}` },
  });
  if (!r.ok) fail(401, 'Your sign-in has expired. Sign in again.');
  const user = await r.json();
  if (!user || !UUID.test(String(user.id || ''))) fail(401, 'Sign in again.');
  // Upserted on every call: the first time anyone signs in is the moment the
  // row is needed, and there is no separate sign-up step to forget.
  await rest('POST', 'organisers?on_conflict=id', [{ id: user.id, email: str(user.email, 200) }],
    'resolution=merge-duplicates,return=minimal');
  return user;
}

const newToken = () => crypto.randomBytes(16).toString('base64url');

// ── Trip contents ───────────────────────────────────────────────────────────
function publicTrip(t) {
  return {
    id: t.id, name: t.name, start_date: t.start_date, end_date: t.end_date,
    currency: t.currency, home_currency: t.home_currency, rate: Number(t.rate) || 1,
    pass: t.pass,
  };
}

async function loadTrip(trip) {
  const T = q(trip.id);
  const [days, items, people, expenses] = await Promise.all([
    select(`trip_days?trip_id=eq.${T}&order=sort_index.asc`),
    select(`trip_items?trip_id=eq.${T}&order=at_time.asc,sort_index.asc`),
    select(`trip_people?trip_id=eq.${T}&order=sort_index.asc`),
    select(`trip_expenses?trip_id=eq.${T}&order=created_at.desc`),
  ]);
  return { trip: publicTrip(trip), days: days || [], items: items || [], people: people || [], expenses: expenses || [] };
}

// Ids a request refers to must belong to this trip. A foreign key would accept
// a day from another trip happily; this is what refuses it.
async function ownedIds(table, trip, ids) {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return true;
  if (!want.every((id) => UUID.test(id))) return false;
  const rows = await select(`${table}?trip_id=eq.${q(trip.id)}&id=in.(${want.map(q).join(',')})&select=id`);
  return (rows || []).length === want.length;
}

function itemFields(b) {
  const category = CATEGORIES.has(b.category) ? b.category : 'activity';
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  return {
    at_time: str(b.at_time, 20),
    title: str(b.title, 120),
    detail: str(b.detail, 2000),
    place: str(b.place, 200),
    lat: num(b.lat), lng: num(b.lng),
    category,
    booked: !!b.booked,
    author: str(b.author, 60),
    updated_at: new Date().toISOString(),
  };
}

function expenseFields(b, trip) {
  const cents = Number(b.amount_cents);
  if (!Number.isInteger(cents) || cents <= 0 || cents > 100000000) fail(400, 'Give it an amount, like 42.50.');
  const currency = b.currency === trip.home_currency ? trip.home_currency : trip.currency;
  const description = str(b.description, 120);
  if (!description) fail(400, 'Say what it was for.');
  const shared = Array.isArray(b.shared_with) ? [...new Set(b.shared_with.map(String))] : [];
  if (!shared.length) fail(400, 'Somebody has to be splitting it.');
  return {
    description,
    amount_cents: cents,
    currency,
    paid_by: idOrFail(b.paid_by),
    shared_with: shared,
    spent_on: isoOrNull(b.spent_on),
    item_id: b.item_id ? idOrFail(b.item_id) : null,
    author: str(b.author, 60),
    updated_at: new Date().toISOString(),
  };
}

// ── Guest actions ───────────────────────────────────────────────────────────
const guest = {
  async load(trip) { return loadTrip(trip); },

  async item_save(trip, b) {
    const it = b.item || {};
    const fields = itemFields(it);
    if (!fields.title) fail(400, 'Give it a name.');
    if (it.id) {
      const rows = await patch(`trip_items?id=eq.${q(idOrFail(it.id))}&trip_id=eq.${q(trip.id)}`, fields);
      if (!rows || !rows[0]) fail(404, 'That has been removed by someone else.');
      return { item: rows[0] };
    }
    const dayId = idOrFail(it.day_id);
    if (!(await ownedIds('trip_days', trip, [dayId]))) fail(404, 'That day is not part of this trip.');
    const rows = await insert('trip_items', [{ ...fields, day_id: dayId, trip_id: trip.id }]);
    return { item: rows[0] };
  },

  async item_delete(trip, b) {
    await remove(`trip_items?id=eq.${q(idOrFail(b.id))}&trip_id=eq.${q(trip.id)}`);
    return { ok: true };
  },

  async day_save(trip, b) {
    const rows = await patch(`trip_days?id=eq.${q(idOrFail(b.id))}&trip_id=eq.${q(trip.id)}`,
      { city: str(b.city, 60) });
    if (!rows || !rows[0]) fail(404, 'That day is not part of this trip.');
    return { day: rows[0] };
  },

  // Moving the first day shifts every day by the same amount, so what was
  // planned for day three stays on day three.
  async dates_shift(trip, b) {
    const first = isoOrNull(b.first);
    if (!first) fail(400, 'Use a date like 2026-10-10.');
    const days = await select(`trip_days?trip_id=eq.${q(trip.id)}&order=sort_index.asc`);
    for (let i = 0; i < days.length; i++) {
      const date = addDays(first, i);
      if (date !== days[i].date) await patch(`trip_days?id=eq.${q(days[i].id)}&trip_id=eq.${q(trip.id)}`, { date });
    }
    const end = days.length ? addDays(first, days.length - 1) : first;
    await patch(`trips?id=eq.${q(trip.id)}`, { start_date: first, end_date: end });
    return { ok: true };
  },

  async person_save(trip, b) {
    const p = b.person || {};
    const name = str(p.name, 40);
    if (!name) fail(400, 'Give them a name.');
    const fields = {
      name,
      from_date: isoOrNull(p.from_date),
      to_date: isoOrNull(p.to_date),
      pay_handle: str(p.pay_handle, 60),
    };
    if (p.id) {
      const rows = await patch(`trip_people?id=eq.${q(idOrFail(p.id))}&trip_id=eq.${q(trip.id)}`, fields);
      if (!rows || !rows[0]) fail(404, 'They have been removed by someone else.');
      return { person: rows[0] };
    }
    const existing = await select(`trip_people?trip_id=eq.${q(trip.id)}&select=id`);
    const rows = await insert('trip_people', [{ ...fields, trip_id: trip.id, sort_index: (existing || []).length }]);
    return { person: rows[0] };
  },

  // Their expenses go with them, and they come out of every split they were
  // in. A settlement that names somebody no longer on the list cannot balance.
  async person_delete(trip, b) {
    const id = idOrFail(b.id);
    if (!(await ownedIds('trip_people', trip, [id]))) fail(404, 'They are not on this trip.');
    const T = q(trip.id);
    await remove(`trip_expenses?paid_by=eq.${q(id)}&trip_id=eq.${T}`);
    const left = await select(`trip_expenses?trip_id=eq.${T}&select=id,shared_with`);
    for (const e of left || []) {
      if (!(e.shared_with || []).includes(id)) continue;
      const shared = e.shared_with.filter((x) => x !== id);
      if (shared.length) await patch(`trip_expenses?id=eq.${q(e.id)}&trip_id=eq.${T}`, { shared_with: shared });
      else await remove(`trip_expenses?id=eq.${q(e.id)}&trip_id=eq.${T}`);
    }
    await remove(`trip_people?id=eq.${q(id)}&trip_id=eq.${T}`);
    return { ok: true };
  },

  async expense_save(trip, b) {
    const e = b.expense || {};
    const fields = expenseFields(e, trip);
    if (!(await ownedIds('trip_people', trip, [fields.paid_by, ...fields.shared_with]))) {
      fail(400, 'Someone in that split is not on this trip any more. Reload and try again.');
    }
    if (fields.item_id && !(await ownedIds('trip_items', trip, [fields.item_id]))) fields.item_id = null;
    if (e.id) {
      const rows = await patch(`trip_expenses?id=eq.${q(idOrFail(e.id))}&trip_id=eq.${q(trip.id)}`, fields);
      if (!rows || !rows[0]) fail(404, 'That expense has been removed by someone else.');
      return { expense: rows[0] };
    }
    const rows = await insert('trip_expenses', [{ ...fields, trip_id: trip.id }]);
    return { expense: rows[0] };
  },

  async expense_delete(trip, b) {
    await remove(`trip_expenses?id=eq.${q(idOrFail(b.id))}&trip_id=eq.${q(trip.id)}`);
    return { ok: true };
  },

  async rate_save(trip, b) {
    const rate = Number(String(b.rate).replace(',', '.'));
    if (!(rate > 0 && rate < 100000)) fail(400, 'That is not a rate.');
    await patch(`trips?id=eq.${q(trip.id)}`, { rate });
    return { rate };
  },

  async receipt_read(trip, b) { return readReceipt(trip, b); },
};

// ── Organiser actions ───────────────────────────────────────────────────────
const organiser = {
  async my_trips(user) {
    const trips = await select(`trips?organiser_id=eq.${q(user.id)}&order=start_date.asc`);
    if (!trips || !trips.length) return { trips: [] };
    const invites = await select(
      `trip_invites?trip_id=in.(${trips.map((t) => q(t.id)).join(',')})&revoked_at=is.null&select=trip_id,token`);
    const tokenFor = Object.fromEntries((invites || []).map((i) => [i.trip_id, i.token]));
    return { trips: trips.map((t) => ({ ...publicTrip(t), token: tokenFor[t.id] || null })) };
  },

  async trip_create(user, b) {
    const name = str(b.name, 80);
    if (!name) fail(400, 'Give the trip a name.');
    const start = isoOrNull(b.start_date), end = isoOrNull(b.end_date);
    if (!start || !end) fail(400, 'Choose the first and last day.');
    const span = daysBetween(start, end);
    if (span < 0) fail(400, 'The last day is before the first.');
    if (span > 59) fail(400, 'Trips can be up to 60 days.');
    const currency = CURRENCY.test(b.currency) ? b.currency : 'USD';
    const home = CURRENCY.test(b.home_currency) ? b.home_currency : currency;
    const rate = currency === home ? 1 : Number(b.rate) > 0 ? Number(b.rate) : 1;

    const [trip] = await insert('trips', [{
      organiser_id: user.id, name, start_date: start, end_date: end,
      currency, home_currency: home, rate,
    }]);
    await insert('trip_days', Array.from({ length: span + 1 }, (_, i) => ({
      trip_id: trip.id, date: addDays(start, i), sort_index: i,
    })));
    const parties = (Array.isArray(b.people) ? b.people : [])
      .map((n) => str(n, 40)).filter(Boolean).slice(0, 40);
    if (parties.length) {
      await insert('trip_people', parties.map((n, i) => ({ trip_id: trip.id, name: n, sort_index: i })));
    }
    const token = newToken();
    await insert('trip_invites', [{ token, trip_id: trip.id }]);
    return { trip: { ...publicTrip(trip), token } };
  },

  // A link forwarded beyond the group is stopped here: the old one stops
  // working at once and everyone else is sent the new one.
  async invite_rotate(user, b) {
    const id = idOrFail(b.trip_id);
    const mine = await select(`trips?id=eq.${q(id)}&organiser_id=eq.${q(user.id)}&select=id`);
    if (!mine || !mine[0]) fail(404, 'That trip is not yours.');
    await patch(`trip_invites?trip_id=eq.${q(id)}&revoked_at=is.null`, { revoked_at: new Date().toISOString() });
    const token = newToken();
    await insert('trip_invites', [{ token, trip_id: id }]);
    return { token };
  },
};

// ── Receipts ────────────────────────────────────────────────────────────────
// PREFILLS and never saves. The two things the split turns on, who paid and
// who was in on it, are the two things a receipt cannot know.
function claudeText(data) {
  return (data && Array.isArray(data.content) ? data.content : [])
    .filter((c) => c && c.type === 'text').map((c) => c.text).join('').trim();
}

async function readReceipt(trip, b) {
  if (!process.env.ANTHROPIC_KEY) fail(500, 'Receipt reading is not switched on yet.');
  const img = b.image || {};
  if (!img.data || typeof img.data !== 'string') fail(400, 'No photo received.');
  if (img.data.length > 7000000) fail(413, 'That photo is too large. Try again, or type the amount in.');
  const mediaType = ['image/jpeg', 'image/png', 'image/webp'].includes(img.mediaType) ? img.mediaType : 'image/jpeg';
  const dates = Array.isArray(b.dates) ? b.dates.filter((d) => ISO.test(d)).slice(0, 60) : [];
  const local = trip.currency, home = trip.home_currency;
  const curs = local === home ? `"${local}"` : `"${local}" or "${home}"`;

  const prompt = `This is a photograph of a receipt from a group trip (${trip.name}). Read it and return what it says.

Respond with ONLY a JSON object, no other text, no markdown, no code fences:
{"amount": "42.50", "currency": "${local}", "description": "Dinner at Botin", "date": "2026-10-13", "note": null}

Rules:
- amount: the FINAL TOTAL actually paid, as a plain number with two decimals and no symbol. Not the subtotal, not the pre-tip line, not any single item. If a tip or service was added, the total INCLUDING it is what was paid. If you cannot find a total with confidence, set amount to null rather than guessing.
- currency: ${curs}, read from the symbol or wording on the receipt. If the receipt shows no symbol and you are inferring from the country, still answer, but say so in note.
- description: a short, plain name a person would write, preferring the place name ("Dinner at Botin", "Taxi to Sants"). Not a list of items, not a transaction id.
- date: the date on the receipt as YYYY-MM-DD, or null if none is legible.${dates.length ? ' The trip runs across these dates, so prefer whichever one matches: ' + dates.join(', ') + '.' : ''}
- note: null when the receipt was clear. Otherwise ONE short sentence saying what was unclear and what you assumed.
- Never invent a value to fill a field. null is always better than a plausible number.`;

  let parsed = null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.RECEIPT_MODEL || 'claude-sonnet-5-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: img.data } },
          { type: 'text', text: prompt },
        ] }],
      }),
    });
    if (r.ok) {
      const text = claudeText(await r.json());
      parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    } else {
      console.error('receipt read failed:', r.status, (await r.text()).slice(0, 300));
    }
  } catch (e) {
    console.error('receipt read error:', e.message);
  }
  await insert('trip_receipts', [{ trip_id: trip.id, person_id: UUID.test(String(b.person_id || '')) ? b.person_id : null, ok: !!parsed }])
    .catch(() => {});
  if (!parsed) fail(502, 'Could not read that receipt. Type the amount in instead.');

  const amount = typeof parsed.amount === 'string' || typeof parsed.amount === 'number' ? String(parsed.amount).trim() : '';
  return {
    amount: /^\d+(\.\d{1,2})?$/.test(amount) ? amount : '',
    currency: parsed.currency === home ? home : local,
    description: typeof parsed.description === 'string' ? parsed.description.slice(0, 120) : '',
    date: ISO.test(String(parsed.date || '')) ? parsed.date : null,
    note: typeof parsed.note === 'string' && parsed.note.trim() ? parsed.note.trim().slice(0, 200) : null,
  };
}

// ── Router ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  try {
    // What a signed-out browser needs to show the sign-in buttons. Both values
    // are public by design; the anon key opens nothing because no table has a
    // policy.
    if (body.action === 'config') {
      res.status(200).json({ supabaseUrl: SB() || '', anonKey: process.env.SUPABASE_ANON_KEY || '' });
      return;
    }
    if (Object.hasOwn(guest, body.action)) {
      const trip = await tripFromToken(body.t);
      res.status(200).json(await guest[body.action](trip, body));
      return;
    }
    if (Object.hasOwn(organiser, body.action)) {
      const user = await organiserFromAuth(body.auth);
      res.status(200).json(await organiser[body.action](user, body));
      return;
    }
    res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return; }
    console.error('unhandled:', e && e.stack || e);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
}
