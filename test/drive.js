// Drives the real pages in jsdom against the local server and stand-in
// database, checking what a person would see and do: an organiser makes a
// trip, a guest opens the link, picks who they are, plans, spends and settles.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, call } from '../dev/serve.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
let fails = 0, total = 0;
const check = (label, ok, extra = '') => {
  total++;
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (extra ? '  ' + extra : ''));
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await serve({ port: 0, quiet: true });
const B = app.base;

// One phone. Passing the storage of an earlier page carries it over, the way
// reopening the same phone would.
function open(page, hash = '', storage = null, offline = false) {
  const html = fs.readFileSync(path.join(PUBLIC, page + '.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: `${B}/${page === 'index' ? '' : page}${hash}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      if (storage) for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
      w.fetch = offline ? () => Promise.reject(new Error('no network')) : (u, o) => fetch(new URL(u, B).toString(), o);
      w.confirm = () => true;
      w.alert = (m) => { w.__alerts = (w.__alerts || []).concat(m); };
      w.prompt = (msg, def) => (w.__prompts && w.__prompts.length ? w.__prompts.shift() : def);
      w.HTMLElement.prototype.scrollIntoView = function () {};
      w.scrollTo = () => {};
    },
  });
  const w = dom.window, d = w.document;
  const $ = (s) => d.querySelector(s);
  const all = (s) => Array.from(d.querySelectorAll(s));
  const text = (s) => ($(s) || {}).textContent || '';
  const storageOf = () => Object.fromEntries(Object.keys(w.localStorage).map((k) => [k, w.localStorage.getItem(k)]));
  return { w, d, $, all, text, storageOf, close: () => w.close() };
}

// ── The organiser makes a trip ──────────────────────────────────────────────
{
  const p = open('index');
  await sleep(400);
  check('signed out, the home page offers sign-in', !p.$('#signed-out').classList.contains('hidden'));
  check('and only the organiser is asked to', /Only the organiser signs in/.test(p.text('#signed-out')));
  check('against the local database the demo organiser is offered', !p.$('#b-demo').classList.contains('hidden'));
  p.w.demoSignIn(); await sleep(400);
  check('signing in lists your trips', /Madrid & Barcelona/.test(p.text('#mine')), p.text('#mine').slice(0, 80));
  p.$('#create-btn').click();
  p.$('#c-name').value = 'Lisbon long weekend';
  p.$('#c-start').value = '2027-03-04';
  p.$('#c-end').value = '2027-03-07';
  p.$('#c-cur').value = 'EUR'; p.$('#c-home').value = 'USD'; p.w.updateRate();
  check('two currencies ask for the agreed rate', !p.$('#c-rate-row').classList.contains('hidden'));
  await p.w.createTrip(); await sleep(200);
  check('a missing rate is asked for', /rate/.test(p.text('#c-err')), p.text('#c-err'));
  p.$('#c-rate').value = '1,10';
  p.$('#c-people').value = 'Ana & Joao\n\nBen\n  Cy  ';
  await p.w.createTrip(); await sleep(400);
  check('creating it shows the link to send', !p.$('#share').classList.contains('hidden') && /\/trip#[A-Za-z0-9_-]{22}$/.test(p.text('#share-link')), p.text('#share-link'));
  check('and it joins your list', /Lisbon long weekend/.test(p.text('#mine')));
  p.close();
}

const lisbon = (await call(B, 'my_trips', { auth: 'demo-organiser' })).body.trips.find((t) => t.name === 'Lisbon long weekend');
check('the trip has its days and people', (await call(B, 'load', { t: lisbon.token })).body.people.map((x) => x.name).join('|') === 'Ana & Joao|Ben|Cy');
check('and the comma rate was read as 1.10', lisbon.rate === 1.1, String(lisbon.rate));

// ── A guest opens the demo link ─────────────────────────────────────────────
const T = app.demo.token;
let g = open('trip', '#' + T);
await sleep(500);
check('the link opens straight to "Who are you?"', !g.$('#join').classList.contains('hidden'));
check('with the trip name', g.text('#j-name') === 'Madrid & Barcelona');
check('and its size', /4 parties · 6 days/.test(g.text('#j-sub')), g.text('#j-sub'));
check('every party is listed', g.all('#j-list label').length === 4);
check('a late arrival shows when they come', /Leo & Ana.*from|Leo & Ana.*to/.test(g.text('#j-list')), g.text('#j-list'));
check('the token is wiped from the address bar', g.w.location.hash === '', g.w.location.href);
g.w.joinAs(); await sleep(50);
check('opening without picking asks you to pick', /Pick who you are/.test(g.text('#j-err')));
g.all('#j-list input')[1].checked = true;
g.w.joinAs(); await sleep(100);
check('picking a party opens the trip', g.$('#join').classList.contains('hidden') && !g.$('#app').classList.contains('hidden'));
check('and says who you are', g.text('#me') === 'Ravi & Meera');

// ── The plan ────────────────────────────────────────────────────────────────
check('six days are shown', g.all('#days .day').length === 6);
check('cities show', g.all('.day-head .city')[0].textContent === 'Madrid' && g.all('.day-head .city')[5].textContent === 'Barcelona');
check('items sit under their day', g.all('#days .day')[1].querySelectorAll('.item').length === 2);
check('times read on the 12-hour clock', /9:30 AM/.test(g.all('#days .day')[1].textContent));
check('booked things are ticked', /✓ Prado Museum/.test(g.all('#days .day')[1].textContent));
check('a day with nothing says so', /Nothing planned/.test(g.all('#days .day')[2].textContent));
check('travel rows have no cost button', !g.all('#days .day')[0].querySelector('.cost'));
check('activity rows do', !!g.all('#days .day')[1].querySelector('.cost'));

g.all('#days .day')[2].querySelector('.add').click();
g.$('#f-title').value = 'Segovia day trip';
g.$('#f-time').value = '08:15';
g.$('#f-cat').value = 'activity';
await g.w.saveItem(); await sleep(300);
const day3 = g.all('#days .day')[2];
check('adding puts it on the right day', /Segovia day trip/.test(day3.textContent));
check('attributed to your party', /added by Ravi & Meera/.test(day3.textContent));

day3.querySelector('.add').click();
g.$('#f-title').value = '  ';
await g.w.saveItem(); await sleep(100);
check('a nameless entry is refused', /name/i.test(g.text('#sheet-err')));
g.w.closeSheet();

// Ticking booked and paid opens the expense sheet, linked to the stop.
const seg = Array.from(g.all('#days .day')[2].querySelectorAll('.item')).find((n) => /Segovia/.test(n.textContent));
seg.querySelector('.edit').click();
g.$('#f-booked').checked = true;
await g.w.saveItem(); await sleep(400);
check('ticking booked opens the expense sheet', g.$('#esheet').classList.contains('open'));
check('already named', g.$('#e-what').value === 'Segovia day trip');
check('on the right day', g.$('#e-date').value === '2026-10-12', g.$('#e-date').value);
check('with you as the payer', g.$('#e-payer').selectedOptions[0].textContent === 'Ravi & Meera');
check('Leo & Ana are in on the 12th, the day they arrive', g.all('#e-with .chip.on').length === 4, String(g.all('#e-with .chip.on').length));
g.$('#e-date').value = '2026-10-11'; g.$('#e-date').onchange();
check('moving it to the 11th leaves them out', g.all('#e-with .chip.on').length === 3 && /not here/.test(g.text('#e-with')));
g.$('#e-amount').value = '100';
await g.w.saveExpense(); await sleep(400);
check('saving lands on the Money tab', !g.$('#money').classList.contains('hidden'));
const segExpense = (await call(B, 'load', { t: T })).body.expenses.find((e) => e.description === 'Segovia day trip');
check('the expense is linked to its stop', !!segExpense && !!segExpense.item_id);
check('100.00 three ways is stored whole', segExpense.amount_cents === 10000);

// ── Money ───────────────────────────────────────────────────────────────────
// Ravi paid 90 (Prado, 3 ways) and 100 (Segovia, 3 ways). Shine paid $1,620
// for the apartment, 4 ways, which is 1500.00 EUR at 1.08.
const money = g.text('#money');
check('the rate is shown', /€1\.00 = \$1\.08/.test(money), g.text('#m-rate'));
check('the total counts the dollars in euros', /€1,690\.00/.test(g.text('#m-total')), g.text('#m-total'));
// Ravi's share: Prado 30.00 + Segovia 33.33 + apartment 375.00, less the 190.00
// paid = 248.33 owed.
check('your own position leads', g.text('#m-mine-big') === 'You owe €248.33', g.text('#m-mine-big'));
const net = g.w.eval('settleUp(people, expenses)').net;
check('balances sum to exactly zero', Object.values(net).reduce((a, b) => a + b, 0) === 0, JSON.stringify(net));
const { transfers } = g.w.eval('settleUp(people, expenses)');
check('settle-up needs at most n-1 payments', transfers.length <= 3, String(transfers.length));
check('your rows are highlighted', g.all('.owe.mine').length >= 1);
const ravi = g.w.eval('people[1].id');
const raviPays = transfers.filter((t) => t.from === ravi).reduce((a, t) => a + t.amount, 0);
check('what you owe is what your transfers pay', raviPays === -net[ravi], `${raviPays} vs ${-net[ravi]}`);

check('odd cents are handed out, not lost', JSON.stringify(Object.values(g.w.shareOut(10000, ['a', 'b', 'c']))) === '[3334,3333,3333]');
check('toCents reads 42.50 exactly', g.w.toCents('42.50') === 4250 && g.w.toCents('42,5') === 4250 && g.w.toCents('4.255') === null);

// A dollar expense keeps its currency and shows its euro value.
g.w.openExpense();
g.$('#e-amount').value = '54.00';
g.$('#e-cur').value = 'USD';
g.$('#e-what').value = 'Taxi';
await g.w.saveExpense(); await sleep(400);
const taxiRow = g.all('#m-list .exp').find((r) => /Taxi/.test(r.textContent));
check('a dollar expense shows in dollars', /\$54\.00/.test(taxiRow.textContent));
check('with its euro value on hover', taxiRow.querySelector('.amt').title === 'about €50.00', taxiRow.querySelector('.amt').title);

g.w.openExpense();
g.$('#e-amount').value = '';
await g.w.saveExpense(); await sleep(50);
check('an expense with no amount is refused', /amount/.test(g.text('#e-err')));
g.$('#e-amount').value = '10'; g.$('#e-what').value = 'Nobody';
g.w.eval('splitWith.clear()');
await g.w.saveExpense(); await sleep(50);
check('an expense nobody shares is refused', /splitting/.test(g.text('#e-err')));
g.w.closeExpense();

// ── Somebody else changes the trip ──────────────────────────────────────────
await call(B, 'item_save', { t: T, item: { day_id: g.w.eval('days[4].id'), at_time: '19:00', title: 'Tapas crawl, El Born', category: 'food', author: 'Dan & Kate' } });
await g.w.load(true);
check('another phone\'s change appears on refresh', /Tapas crawl/.test(g.all('#days .day')[4].textContent));

// ── The same phone, reopened ────────────────────────────────────────────────
const saved = g.storageOf();
g.close();
g = open('trip', '', saved);
await sleep(500);
check('reopened without the link, it opens the last trip', g.text('#trip-name') === 'Madrid & Barcelona');
check('and remembers who you are', g.$('#join').classList.contains('hidden') && g.text('#me') === 'Ravi & Meera');

// ── Two trips on one phone never mix ────────────────────────────────────────
const g2 = open('trip', '#' + lisbon.token, g.storageOf());
await sleep(500);
check('a second trip asks who you are there', !g2.$('#join').classList.contains('hidden') && g2.text('#j-name') === 'Lisbon long weekend');
g2.all('#j-list input')[0].checked = true; g2.w.joinAs(); await sleep(100);
check('and shows only its own plan', !/Prado|Segovia/.test(g2.text('#days')) && g2.all('#days .day').length === 4);
check('in its own currencies', /€1\.00 = \$1\.10/.test(g2.text('#m-rate')), g2.text('#m-rate'));
const homeP = open('index', '', g2.storageOf());
await sleep(400);
check('the home page lists both trips on this phone', /Madrid & Barcelona/.test(homeP.text('#phone-list')) && /Lisbon long weekend/.test(homeP.text('#phone-list')));
homeP.close(); g2.close();

// ── Offline ─────────────────────────────────────────────────────────────────
const offline = open('trip', '', g.storageOf(), true);
await sleep(300);
check('offline, the cached plan still shows', /Segovia/.test(offline.text('#days')));
check('and says it is not connected', offline.text('#status') === 'Offline');
offline.close();

// ── The organiser issues a new link ─────────────────────────────────────────
await call(B, 'invite_rotate', { auth: 'demo-organiser', trip_id: app.demo.tripId });
await g.w.load(true); await sleep(100);
check('an old link shows a plain message', !g.$('#gate').classList.contains('hidden') && /out of date/.test(g.text('#gate-msg')), g.text('#gate-msg'));
check('and the trip is forgotten on this phone', !JSON.parse(g.w.localStorage.getItem('gt.trips'))[T]);
g.close();

// ── A guest not on the list ─────────────────────────────────────────────────
const fresh = (await call(B, 'my_trips', { auth: 'demo-organiser' })).body.trips.find((t) => t.name === 'Lisbon long weekend');
const n = open('trip', '#' + fresh.token);
await sleep(500);
n.w.__prompts = ['Dee'];
await n.w.joinAsNew(); await sleep(400);
check('"I\'m not on this list" adds you and opens the trip', n.text('#me') === 'Dee' && n.$('#join').classList.contains('hidden'));
n.close();

const bare = open('trip');
await sleep(300);
check('the bare page asks for the link', !bare.$('#gate').classList.contains('hidden') && bare.$('#app').classList.contains('hidden'));
bare.close();

app.close();
console.log(`\n${total - fails}/${total} passed`);
process.exit(fails ? 1 : 0);
