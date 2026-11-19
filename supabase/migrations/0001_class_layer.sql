-- 0001_class_layer.sql — the IMBUUID class layer for Vercel Board.
--
-- Target: Supabase project "board" (SomacoSF org, us-west-2). This migration
-- ships in the repo as the class layer's schema; it is applied by the
-- operator, not by any app in this repo.
--
-- What lives here: the class layer's own tables — the Identity registry, the
-- receipt chain, escrow state, and the mission-control read model. Board's
-- own event log stays in Board's store; receipts here reference Board events
-- by their identifiers and carry the chain links themselves.
--
-- Access posture: row-level security is ENABLED on every table below, with
-- NO policies defined. With RLS on and no policy, the public (anon and
-- authenticated) roles can neither read nor write a row. All access goes
-- through the service role, which bypasses RLS — server-side code holding
-- the service-role key is the only reader and writer of this schema.

-- ---------------------------------------------------------------------------
-- identities — the registry. One row per identified thing: actor, task,
-- claim, decision, receipt, escrow container. The UUID is the address; the
-- type segment of the identifier names what it is, and type_code records the
-- same fact in queryable form. ceiling is the capability profile committed
-- to the Identity; profile_commitment is the tamper-evident commitment to
-- that profile's body, resolved against the registry at act time.
-- ---------------------------------------------------------------------------
create table public.identities (
  uuid               uuid primary key,
  type_code          integer not null,
  ceiling            jsonb not null default '{}'::jsonb,
  profile_commitment text,
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- receipts — the hash-linked receipt chain. Every task-lifecycle event
-- (created, claimed, renewed, completed, failed, refused, released) emits
-- one receipt. prev_hash links each receipt to the one before it; hash is
-- this receipt's own link value. A walk from any receipt reconstructs who
-- acted, under what ceiling, on what decision. Refusals are receipts too:
-- action names the refusal and payload carries the ceiling clause.
-- ---------------------------------------------------------------------------
create table public.receipts (
  uuid       uuid primary key,
  prev_hash  text,
  hash       text not null,
  actor_uuid uuid references public.identities (uuid),
  action     text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index receipts_actor_idx on public.receipts (actor_uuid);
create index receipts_created_idx on public.receipts (created_at);

-- ---------------------------------------------------------------------------
-- escrow_accounts — one account per task that carries value. The account is
-- keyed by the task's own UUID: value is held under the task's Identity.
-- state tracks the account's place in the wallet -> subwallet -> escrow ->
-- settlement chain (e.g. funded, held, released, expired, disputed).
-- ---------------------------------------------------------------------------
create table public.escrow_accounts (
  task_uuid  uuid primary key,
  balance    numeric(18, 4) not null default 0,
  state      text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- escrow_holds — individual holds against a task's escrow account. A hold
-- releases against a verified completion receipt; release_receipt_uuid names
-- the receipt that released it, so the settlement is a link in the same
-- chain as the work. Failure, dispute, and expiry close a hold by their own
-- state values, each receipted in public.receipts.
-- ---------------------------------------------------------------------------
create table public.escrow_holds (
  uuid                 uuid primary key,
  task_uuid            uuid not null references public.escrow_accounts (task_uuid),
  amount               numeric(18, 4) not null,
  state                text not null,
  release_receipt_uuid uuid references public.receipts (uuid),
  created_at           timestamptz not null default now()
);

create index escrow_holds_task_idx on public.escrow_holds (task_uuid);

-- ---------------------------------------------------------------------------
-- dash_snapshots — the mission-control read model. One row per snapshot the
-- dashboard served: the full snapshot document (channels, tasks, claims,
-- feed, roster) as jsonb, kept so a past state of the board can be re-read
-- exactly as the dashboard showed it.
-- ---------------------------------------------------------------------------
create table public.dash_snapshots (
  id        bigint generated always as identity primary key,
  taken_at  timestamptz not null default now(),
  snapshot  jsonb not null
);

-- ---------------------------------------------------------------------------
-- Row-level security: enabled on all five tables, no policies. See the
-- header — service-role access only.
-- ---------------------------------------------------------------------------
alter table public.identities      enable row level security;
alter table public.receipts        enable row level security;
alter table public.escrow_accounts enable row level security;
alter table public.escrow_holds    enable row level security;
alter table public.dash_snapshots  enable row level security;
