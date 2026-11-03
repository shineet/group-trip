// The server against the stand-in database. Most of this is about one thing:
// a trip's link can never read or change another trip.
import { serve, call } from '../dev/serve.js';

let fails = 0, total = 0;
const check = (label, ok, extra = '') => {
  total++;
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (extra ? '  ' + extra : ''));
  if (!ok) fails++;
};

const app = await serve({ port: 0, seed: false, quiet: true });
const B = app.base;
const A_ORG = 'demo-organiser', B_ORG = 'other-organiser';

// ── Organisers ──────────────────────────────────────────────────────────────
let r = await call(B, 'my_trips', {});
check('signed out cannot list trips', r.status === 401);
r = await call(B, 'my_trips', { auth: 'nonsense' });
check('a bad sign-in is refused', r.status === 401);

r = await call(B, 'trip_create', { auth: A_ORG, name: 'Lisbon', start_date: '2027-03-01', end_date: '2027-03-04',
  currency: 'EUR', home_currency: 'USD', rate: 1.1, people: ['Ana', 'Ben & Cy', ' ', 'Dee'] });
check('an organiser can make a trip', r.status === 200 && !!r.body.trip.token, JSON.stringify(r.body).slice(0, 120));
const tripA = r.body.trip, tA = tripA.token;
check('the invite token is long and random', /^[A-Za-z0-9_-]{22}$/.test(tA), tA);

r = await call(B, 'trip_create', { auth: B_ORG, name: 'Austin', start_date: '2027-05-01', end_date: '2027-05-02', currency: 'USD', home_currency: 'USD', people: ['X', 'Y'] });
const tripB = r.body.trip, tB = tripB.token;
check('a trip in one currency keeps a rate of 1', tripB.rate === 1, String(tripB.rate));

r = await call(B, 'trip_create', { auth: A_ORG, name: 'Bad', start_date: '2027-03-05', end_date: '2027-03-01' });
check('a last day before the first is refused', r.status === 400);
r = await call(B, 'trip_create', { auth: A_ORG, name: 'Long', start_date: '2027-01-01', end_date: '2027-06-01' });
check('a trip over 60 days is refused', r.status === 400);

r = await call(B, 'my_trips', { auth: A_ORG });
check('an organiser sees only their own trips', r.body.trips.length === 1 && r.body.trips[0].name === 'Lisbon');
check('with the link to share', r.body.trips[0].token === tA);
check('the organiser row exists before their trip does', app.fake.db().organisers.some((o) => o.email === 'organiser@example.com'));

// ── A guest loads the trip ──────────────────────────────────────────────────
r = await call(B, 'load', { t: tA });
check('the link opens the trip', r.status === 200 && r.body.trip.name === 'Lisbon');
const A = r.body;
check('one day per date, first to last', A.days.length === 4 && A.days[0].date === '2027-03-01' && A.days[3].date === '2027-03-04', A.days.map((d) => d.date).join(','));
check('blank party names are dropped', A.people.map((p) => p.name).join('|') === 'Ana|Ben & Cy|Dee');
check('the organiser id is not sent to guests', !('organiser_id' in A.trip));

r = await call(B, 'load', { t: 'x'.repeat(22) });
check('a made-up link is refused', r.status === 401);
r = await call(B, 'load', {});
check('no link is refused', r.status === 401);

const Bt = (await call(B, 'load', { t: tB })).body;

// ── Writes stay inside the trip ─────────────────────────────────────────────
r = await call(B, 'item_save', { t: tA, item: { day_id: A.days[1].id, at_time: '10:00', title: 'Tram 28', category: 'activity', author: 'Ana', trip_id: tripB.id } });
check('a guest can add to the plan', r.status === 200);
const item = r.body.item;
check('and the trip comes from the link, not the request', item.trip_id === tripA.id);

r = await call(B, 'item_save', { t: tA, item: { day_id: Bt.days[0].id, title: 'Sneak in' } });
check('adding to another trip\'s day is refused', r.status === 404);
r = await call(B, 'item_save', { t: tB, item: { id: item.id, title: 'Hijacked' } });
check('editing another trip\'s item finds nothing', r.status === 404);
r = await call(B, 'item_delete', { t: tB, id: item.id });
r = await call(B, 'load', { t: tA });
check('deleting it from another trip does nothing', r.body.items.some((i) => i.id === item.id && i.title === 'Tram 28'));
check('another trip\'s rows never appear', !(await call(B, 'load', { t: tB })).body.items.some((i) => i.id === item.id));

r = await call(B, 'item_save', { t: tA, item: { day_id: A.days[1].id, title: '   ' } });
check('an item with no name is refused', r.status === 400);
r = await call(B, 'item_save', { t: tA, item: { day_id: A.days[1].id, title: 'Odd', category: 'drop table' } });
check('an unknown kind falls back to activity', r.body.item.category === 'activity');

r = await call(B, 'day_save', { t: tB, id: A.days[0].id, city: 'Nope' });
check('renaming another trip\'s day is refused', r.status === 404);
r = await call(B, 'day_save', { t: tA, id: A.days[0].id, city: 'Lisbon' });
check('renaming your own day works', r.status === 200 && r.body.day.city === 'Lisbon');

// ── Money ───────────────────────────────────────────────────────────────────
const [ana, ben, dee] = A.people;
r = await call(B, 'expense_save', { t: tA, expense: { description: 'Dinner', amount_cents: 10000, currency: 'EUR', paid_by: ana.id, shared_with: [ana.id, ben.id, dee.id], spent_on: '2027-03-02', item_id: item.id } });
check('an expense saves', r.status === 200 && r.body.expense.amount_cents === 10000);
const dinner = r.body.expense;
check('linked to its stop', dinner.item_id === item.id);

r = await call(B, 'expense_save', { t: tA, expense: { description: 'Sneaky', amount_cents: 500, paid_by: ana.id, shared_with: [ana.id, Bt.people[0].id] } });
check('splitting with someone from another trip is refused', r.status === 400);
r = await call(B, 'expense_save', { t: tA, expense: { description: 'Sneaky', amount_cents: 500, paid_by: Bt.people[0].id, shared_with: [ana.id] } });
check('a payer from another trip is refused', r.status === 400);
r = await call(B, 'expense_save', { t: tA, expense: { description: 'Float', amount_cents: 42.5, paid_by: ana.id, shared_with: [ana.id] } });
check('a fractional cent amount is refused', r.status === 400);
r = await call(B, 'expense_save', { t: tA, expense: { description: 'Yen', amount_cents: 500, currency: 'JPY', paid_by: ana.id, shared_with: [ana.id] } });
check('a currency outside the trip becomes the local one', r.body.expense.currency === 'EUR');
await call(B, 'expense_delete', { t: tA, id: r.body.expense.id });

r = await call(B, 'expense_delete', { t: tB, id: dinner.id });
check('another trip cannot delete an expense', (await call(B, 'load', { t: tA })).body.expenses.some((e) => e.id === dinner.id));

r = await call(B, 'rate_save', { t: tA, rate: '1,15' });
check('the rate takes a comma decimal', r.status === 200 && r.body.rate === 1.15);
r = await call(B, 'rate_save', { t: tA, rate: '-3' });
check('a negative rate is refused', r.status === 400);

// ── People ──────────────────────────────────────────────────────────────────
r = await call(B, 'person_save', { t: tA, person: { name: 'Eve', from_date: '2027-03-03', to_date: '2027-03-04' } });
check('a party can be added with dates', r.status === 200 && r.body.person.from_date === '2027-03-03' && r.body.person.sort_index === 3);
r = await call(B, 'person_delete', { t: tB, id: ben.id });
check('another trip cannot remove a party', r.status === 404);
r = await call(B, 'expense_save', { t: tA, expense: { description: 'Taxi', amount_cents: 2000, paid_by: ben.id, shared_with: [ben.id, dee.id] } });
r = await call(B, 'person_delete', { t: tA, id: ben.id });
const after = (await call(B, 'load', { t: tA })).body;
check('removing a party removes what they paid', !after.expenses.some((e) => e.description === 'Taxi'));
check('and takes them out of other splits', after.expenses.find((e) => e.id === dinner.id).shared_with.join() === [ana.id, dee.id].join());

// ── Dates ───────────────────────────────────────────────────────────────────
r = await call(B, 'dates_shift', { t: tA, first: '2027-04-10' });
const shifted = (await call(B, 'load', { t: tA })).body;
check('moving the first day moves them all', shifted.days.map((d) => d.date).join() === '2027-04-10,2027-04-11,2027-04-12,2027-04-13');
check('and the trip dates follow', shifted.trip.start_date === '2027-04-10' && shifted.trip.end_date === '2027-04-13');
check('the items stay on their day', shifted.items.find((i) => i.id === item.id).day_id === A.days[1].id);

// ── Revoking a link ─────────────────────────────────────────────────────────
r = await call(B, 'invite_rotate', { auth: B_ORG, trip_id: tripA.id });
check('only the organiser can reissue the link', r.status === 404);
r = await call(B, 'invite_rotate', { auth: A_ORG, trip_id: tripA.id });
check('the organiser can reissue it', r.status === 200 && r.body.token && r.body.token !== tA);
check('the old link stops working', (await call(B, 'load', { t: tA })).status === 401);
check('the new one works', (await call(B, 'load', { t: r.body.token })).status === 200);
check('my_trips shows the new link', (await call(B, 'my_trips', { auth: A_ORG })).body.trips[0].token === r.body.token);

// ── Receipts ────────────────────────────────────────────────────────────────
r = await call(B, 'receipt_read', { t: r.body.token, image: { data: 'abc' } });
check('receipts say plainly when they are not switched on', r.status === 500 && /not switched on/.test(r.body.error));

r = await call(B, 'drop_everything', { t: tB });
check('an unknown action is refused', r.status === 400);
r = await call(B, 'constructor', { t: tB });
check('object built-ins are not actions', r.status === 400);

app.close();
console.log(`\n${total - fails}/${total} passed`);
process.exit(fails ? 1 : 0);
