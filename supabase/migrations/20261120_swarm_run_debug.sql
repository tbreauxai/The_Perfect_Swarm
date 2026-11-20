-- DON'T APPLY FROM IDE (Tyler approves in Code Auditor's chat)

create table if not exists public.swarm_run_debug (
  workflow_id text primary key,
  created_at timestamptz not null default now(),
  payload jsonb not null
);

create index if not exists idx_swarm_run_debug_created_at
  on public.swarm_run_debug (created_at);

alter table public.swarm_run_debug enable row level security;

revoke all on table public.swarm_run_debug from anon, authenticated;
grant all on table public.swarm_run_debug to service_role;
