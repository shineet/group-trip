-- Group trip planner. Run once in the SQL editor of this app's own Supabase
-- project (not MyCRM: Vercel Hobby and the booking project are not for a
-- product people pay for).
--
-- Row level security is ON with NO policies on every table. Nothing reaches
-- these rows except the server in api/index.js using the service key, and the
-- server adds the trip id to every query itself. A browser holding the anon
-- key can sign an organiser in and do nothing else.

create table if not exists organisers (
  id          uuid primary key,              -- auth.users id
  email       text        not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists trips (
  id            uuid primary key default gen_random_uuid(),
  organiser_id  uuid        not null references organisers(id) on delete cascade,
  name          text        not null default '',
  start_date    date        not null,
  end_date      date        not null,
  -- Settled in the local currency, the one most of the trip is spent in. The
  -- home currency is only ever a second figure beside it.
  currency      text        not null default 'EUR',
  home_currency text        not null default 'USD',
  -- Home units per one local unit, agreed once for the whole trip. Every card
  -- uses its own rate on the day; what is fair between friends is that
  -- everyone is converted by the SAME number.
  rate          numeric     not null default 1,
  pass          text        not null default 'free',   -- free | trip | yearly
  created_at    timestamptz not null default now()
);

-- The shared link. A trip can have its link revoked and a new one issued
-- without touching anything else.
create table if not exists trip_invites (
  token       text primary key,
  trip_id     uuid        not null references trips(id) on delete cascade,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists trip_people (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid        not null references trips(id) on delete cascade,
  -- A "person" is a party: a couple settles as one.
  name        text        not null default '',
  -- When they are actually on the trip. Null means the whole thing.
  from_date   date,
  to_date     date,
  pay_handle  text        not null default '',
  sort_index  int         not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists trip_days (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid        not null references trips(id) on delete cascade,
  date        date        not null,
  city        text        not null default '',
  note        text        not null default '',
  sort_index  int         not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists trip_items (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid        not null references trips(id) on delete cascade,
  day_id      uuid        not null references trip_days(id) on delete cascade,
  at_time     text        not null default '',
  title       text        not null default '',
  detail      text        not null default '',
  place       text        not null default '',
  lat         double precision,               -- filled by place search (phase 2)
  lng         double precision,
  category    text        not null default 'activity',
  booked      boolean     not null default false,
  author      text        not null default '',
  sort_index  int         not null default 0,
  updated_at  timestamptz not null default now()
);

-- Money in CENTS as an integer: 100.00 three ways in floating point does not
-- add back up, and a settlement built on that never reaches zero.
create table if not exists trip_expenses (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid        not null references trips(id) on delete cascade,
  item_id      uuid        references trip_items(id) on delete set null,
  spent_on     date,
  description  text        not null default '',
  amount_cents integer     not null default 0,
  currency     text        not null default 'EUR',   -- as paid, never converted on the way in
  paid_by      uuid        references trip_people(id) on delete cascade,
  shared_with  uuid[]      not null default '{}',
  author       text        not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One row per photo read, so the free allowance can be counted.
create table if not exists trip_receipts (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid        not null references trips(id) on delete cascade,
  person_id   uuid        references trip_people(id) on delete set null,
  ok          boolean     not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists trips_organiser_idx   on trips (organiser_id, start_date);
create index if not exists trip_invites_trip_idx on trip_invites (trip_id);
create index if not exists trip_people_trip_idx  on trip_people (trip_id, sort_index);
create index if not exists trip_days_trip_idx    on trip_days (trip_id, sort_index);
create index if not exists trip_items_day_idx    on trip_items (trip_id, day_id, at_time, sort_index);
create index if not exists trip_expenses_trip_idx on trip_expenses (trip_id, spent_on);
create index if not exists trip_receipts_trip_idx on trip_receipts (trip_id);

alter table organisers    enable row level security;
alter table trips         enable row level security;
alter table trip_invites  enable row level security;
alter table trip_people   enable row level security;
alter table trip_days     enable row level security;
alter table trip_items    enable row level security;
alter table trip_expenses enable row level security;
alter table trip_receipts enable row level security;
