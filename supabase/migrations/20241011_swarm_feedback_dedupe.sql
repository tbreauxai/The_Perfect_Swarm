create table if not exists public.swarm_feedback_dedupe (
  dedupe_key text primary key,
  created_at timestamptz default now()
);

alter table public.swarm_feedback_dedupe enable row level security;

revoke all on table public.swarm_feedback_dedupe from anon, authenticated;
grant all on table public.swarm_feedback_dedupe to service_role;
