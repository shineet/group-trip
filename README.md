# Group Trip (working name)

Plan a trip together; the money sorts itself out. The organiser signs in and
creates a trip; everyone else opens one link, picks who they are, and plans,
spends and settles up. Grown out of `shine-booking/spain.html`.

Build plan: https://claude.ai/artifact/PB5QMqG21C9FxVGnKypZ3h

## Layout

- `public/index.html` -- home: organiser sign-in, trips you organise, create a trip, trips on this phone
- `public/trip.html` -- the trip itself: join screen, plan, money, settle-up (port of spain.html)
- `api/index.js` -- the one server function; every action is scoped to the trip its invite token names
- `schema.sql` -- run once in this app's own Supabase project
- `dev/serve.js` -- local server; without `SUPABASE_URL` it runs a stand-in database with a demo trip
- `test/` -- `api.test.js` (server, mostly trip isolation) and `drive.js` (pages in jsdom)

## Run

    npm install
    npm run dev      # prints a guest link for the demo trip; "Use the demo organiser" on the home page
    npm test

## Env (Vercel)

`SUPABASE_URL`, `SUPABASE_SECRET_KEY` (service key, server only), `SUPABASE_ANON_KEY`
(browser sign-in only; no table has a policy, so it opens nothing),
`ANTHROPIC_KEY` (receipt reading), optional `RECEIPT_MODEL`.
