-- =====================================================================
-- NidusLab Finance — Supabase schema (isolated: every object is prefixed `fin_`)
-- Safe to run on a shared project: touches nothing that does not start with fin_ / fin-
-- =====================================================================

-- ---------- Tables ----------
create table if not exists public.fin_profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text not null unique,
  full_name  text not null default '',
  role       text not null default 'PENDING' check (role in ('PENDING','EMPLOYEE','FINANCE','ADMIN')),
  created_at timestamptz not null default now()
);

create table if not exists public.fin_employees (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.fin_expenses (
  id             uuid primary key default gen_random_uuid(),
  date           date not null check (date >= date '2026-10-01'),
  category       text not null,
  account_code   text not null default '5150',
  description    text not null default '',
  amount         numeric(14,2) not null check (amount > 0),
  paid_by        text not null check (paid_by in ('COMPANY','EMPLOYEE')),
  payment_method text not null default 'CASH',
  employee       text,
  notes          text not null default '',
  photo_path     text,
  photo_name     text,
  photo_mime     text,
  created_by     uuid default auth.uid() references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists fin_expenses_date_idx on public.fin_expenses(date);

create table if not exists public.fin_expense_payments (
  id         uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.fin_expenses(id) on delete cascade,
  kind       text not null default 'REIMBURSE' check (kind in ('REIMBURSE')),
  date       date not null check (date >= date '2026-10-01'),
  amount     numeric(14,2) not null check (amount > 0),
  method     text not null default 'CASH',
  note       text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists fin_payments_expense_idx on public.fin_expense_payments(expense_id);

create table if not exists public.fin_funds (
  id          uuid primary key default gen_random_uuid(),
  date        date not null check (date >= date '2026-10-01'),
  type        text not null check (type in ('IN','OUT')),
  description text not null default '',
  amount      numeric(14,2) not null check (amount > 0),
  method      text not null default 'CASH',
  created_by  uuid default auth.uid() references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists fin_funds_date_idx on public.fin_funds(date);

-- ---------- Role helpers (SECURITY DEFINER so RLS on fin_profiles cannot recurse) ----------
create or replace function public.fin_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.fin_profiles where id = auth.uid()
$$;
create or replace function public.fin_can_read() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.fin_role() in ('EMPLOYEE','FINANCE','ADMIN'), false)
$$;
create or replace function public.fin_can_write() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.fin_role() in ('FINANCE','ADMIN'), false)
$$;
create or replace function public.fin_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.fin_role() = 'ADMIN', false)
$$;
revoke all on function public.fin_role(), public.fin_can_read(), public.fin_can_write(), public.fin_is_admin() from public, anon;
grant execute on function public.fin_role(), public.fin_can_read(), public.fin_can_write(), public.fin_is_admin() to authenticated;

-- ---------- Profile auto-create (only for users created by this app) ----------
create or replace function public.fin_handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.raw_user_meta_data ->> 'app' = 'niduslab_finance' then
    insert into public.fin_profiles (id, username, full_name, role)
    values (new.id, lower(new.raw_user_meta_data ->> 'username'), coalesce(new.raw_user_meta_data ->> 'name', ''),
      -- first person to join becomes ADMIN; everyone after waits for approval
      case when not exists (select 1 from public.fin_profiles) then 'ADMIN' else 'PENDING' end)
    on conflict (id) do nothing;
  end if;
  return new;
end $$;
revoke all on function public.fin_handle_new_user() from public, anon, authenticated;

drop trigger if exists fin_on_auth_user_created on auth.users;
create trigger fin_on_auth_user_created
  after insert on auth.users
  for each row execute function public.fin_handle_new_user();

-- ---------- Row Level Security ----------
alter table public.fin_profiles         enable row level security;
alter table public.fin_employees        enable row level security;
alter table public.fin_expenses         enable row level security;
alter table public.fin_expense_payments enable row level security;
alter table public.fin_funds            enable row level security;

revoke all on public.fin_profiles, public.fin_employees, public.fin_expenses, public.fin_expense_payments, public.fin_funds from anon;
grant select, insert, update, delete on public.fin_profiles, public.fin_employees, public.fin_expenses, public.fin_expense_payments, public.fin_funds to authenticated;

-- profiles: everyone sees own row (to learn PENDING status); admin sees & manages all
drop policy if exists fin_profiles_select on public.fin_profiles;
create policy fin_profiles_select on public.fin_profiles for select to authenticated
  using (id = auth.uid() or public.fin_is_admin());
drop policy if exists fin_profiles_update on public.fin_profiles;
create policy fin_profiles_update on public.fin_profiles for update to authenticated
  using (public.fin_is_admin()) with check (public.fin_is_admin());
drop policy if exists fin_profiles_delete on public.fin_profiles;
create policy fin_profiles_delete on public.fin_profiles for delete to authenticated
  using (public.fin_is_admin() and id <> auth.uid());

-- data tables: approved users read; Finance/Admin write
do $$
declare t text;
begin
  foreach t in array array['fin_employees','fin_expenses','fin_expense_payments','fin_funds'] loop
    execute format('drop policy if exists %I on public.%I', t||'_select', t);
    execute format('drop policy if exists %I on public.%I', t||'_insert', t);
    execute format('drop policy if exists %I on public.%I', t||'_update', t);
    execute format('drop policy if exists %I on public.%I', t||'_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.fin_can_read())', t||'_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.fin_can_write())', t||'_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.fin_can_write()) with check (public.fin_can_write())', t||'_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.fin_can_write())', t||'_delete', t);
  end loop;
end $$;

-- ---------- Receipt storage (private bucket) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('fin-receipts', 'fin-receipts', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;

drop policy if exists fin_receipts_select on storage.objects;
drop policy if exists fin_receipts_insert on storage.objects;
drop policy if exists fin_receipts_update on storage.objects;
drop policy if exists fin_receipts_delete on storage.objects;
create policy fin_receipts_select on storage.objects for select to authenticated
  using (bucket_id = 'fin-receipts' and public.fin_can_read());
create policy fin_receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'fin-receipts' and public.fin_can_write());
create policy fin_receipts_update on storage.objects for update to authenticated
  using (bucket_id = 'fin-receipts' and public.fin_can_write()) with check (bucket_id = 'fin-receipts' and public.fin_can_write());
create policy fin_receipts_delete on storage.objects for delete to authenticated
  using (bucket_id = 'fin-receipts' and public.fin_can_write());

-- ---------- Realtime (multi-user live refresh; respects RLS) ----------
do $$
declare t text;
begin
  foreach t in array array['fin_employees','fin_expenses','fin_expense_payments','fin_funds'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- Seed: default employees (same as the old single-file app) ----------
insert into public.fin_employees (name) values ('Prima Islam'), ('Rahim Uddin'), ('Karim Ahmed')
on conflict (name) do nothing;

notify pgrst, 'reload schema';
-- Lets an existing NidusLab login (e.g. from another app on this shared project) join Finance.
create or replace function public.fin_claim_profile(p_username text, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.fin_profiles (id, username, full_name, role)
  values (auth.uid(), lower(p_username), coalesce(p_name, ''),
    case when not exists (select 1 from public.fin_profiles) then 'ADMIN' else 'PENDING' end)
  on conflict (id) do nothing;
end $$;
revoke all on function public.fin_claim_profile(text, text) from public, anon;
grant execute on function public.fin_claim_profile(text, text) to authenticated;
notify pgrst, 'reload schema';
-- Team invite code: people who sign up with the code join as EMPLOYEE (view-only) instantly.
-- Without the code they stay PENDING until an admin approves. First ever user is ADMIN.
create table if not exists public.fin_settings (key text primary key, value text not null);
alter table public.fin_settings enable row level security;
revoke all on public.fin_settings from anon;
grant select, insert, update on public.fin_settings to authenticated;
drop policy if exists fin_settings_admin on public.fin_settings;
create policy fin_settings_admin on public.fin_settings for all to authenticated
  using (public.fin_is_admin()) with check (public.fin_is_admin());
insert into public.fin_settings (key, value) values ('invite_code', 'NIDUS-FIN-7K3Q') on conflict (key) do nothing;

create or replace function public.fin_pick_role(p_code text) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when not exists (select 1 from public.fin_profiles) then 'ADMIN'
    when coalesce(trim(p_code), '') <> '' and exists (select 1 from public.fin_settings where key = 'invite_code' and upper(value) = upper(trim(p_code))) then 'EMPLOYEE'
    else 'PENDING' end
$$;
revoke all on function public.fin_pick_role(text) from public, anon, authenticated;

create or replace function public.fin_handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.raw_user_meta_data ->> 'app' = 'niduslab_finance' then
    insert into public.fin_profiles (id, username, full_name, role)
    values (new.id, lower(new.raw_user_meta_data ->> 'username'), coalesce(new.raw_user_meta_data ->> 'name', ''),
      public.fin_pick_role(new.raw_user_meta_data ->> 'invite'))
    on conflict (id) do nothing;
  end if;
  return new;
end $$;

drop function if exists public.fin_claim_profile(text, text);
create or replace function public.fin_claim_profile(p_username text, p_name text, p_invite text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.fin_profiles (id, username, full_name, role)
  values (auth.uid(), lower(p_username), coalesce(p_name, ''), public.fin_pick_role(p_invite))
  on conflict (id) do nothing;
end $$;
revoke all on function public.fin_claim_profile(text, text, text) from public, anon;
grant execute on function public.fin_claim_profile(text, text, text) to authenticated;
notify pgrst, 'reload schema';
select value as invite_code from public.fin_settings where key='invite_code';
-- Features: cost funds, employee requests (approval), avatars, restricted employee visibility
alter table public.fin_expenses add column if not exists cost_fund text not null default '';
alter table public.fin_expenses add column if not exists status text not null default 'APPROVED';
alter table public.fin_expenses drop constraint if exists fin_expenses_status_chk;
alter table public.fin_expenses add constraint fin_expenses_status_chk check (status in ('PENDING','APPROVED'));
alter table public.fin_profiles add column if not exists avatar_path text;

create table if not exists public.fin_cost_funds (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);
alter table public.fin_cost_funds enable row level security;
revoke all on public.fin_cost_funds from anon;
grant select, insert, delete on public.fin_cost_funds to authenticated;
drop policy if exists fin_cost_funds_select on public.fin_cost_funds;
drop policy if exists fin_cost_funds_insert on public.fin_cost_funds;
drop policy if exists fin_cost_funds_delete on public.fin_cost_funds;
create policy fin_cost_funds_select on public.fin_cost_funds for select to authenticated using (public.fin_can_read());
create policy fin_cost_funds_insert on public.fin_cost_funds for insert to authenticated with check (public.fin_can_read());
create policy fin_cost_funds_delete on public.fin_cost_funds for delete to authenticated using (public.fin_can_write());
insert into public.fin_cost_funds (name) values ('NidusTime'), ('NidusJob'), ('NidusLab') on conflict (name) do nothing;

-- Expenses: admin/finance see all; employee sees own and may only INSERT own pending requests
drop policy if exists fin_expenses_select on public.fin_expenses;
drop policy if exists fin_expenses_insert on public.fin_expenses;
create policy fin_expenses_select on public.fin_expenses for select to authenticated
  using (public.fin_can_write() or created_by = auth.uid());
create policy fin_expenses_insert on public.fin_expenses for insert to authenticated
  with check (public.fin_can_write() or (public.fin_role() = 'EMPLOYEE' and status = 'PENDING' and paid_by = 'EMPLOYEE' and created_by = auth.uid()));

drop policy if exists fin_expense_payments_select on public.fin_expense_payments;
create policy fin_expense_payments_select on public.fin_expense_payments for select to authenticated
  using (public.fin_can_write() or exists (select 1 from public.fin_expenses e where e.id = expense_id and e.created_by = auth.uid()));

drop policy if exists fin_funds_select on public.fin_funds;
create policy fin_funds_select on public.fin_funds for select to authenticated using (public.fin_can_write());

-- Members list (names for the Employee picker) visible to approved users
drop policy if exists fin_profiles_members on public.fin_profiles;
create policy fin_profiles_members on public.fin_profiles for select to authenticated
  using (public.fin_can_read() and role <> 'PENDING');

-- Own avatar
create or replace function public.fin_set_avatar(p_path text) returns void
language sql security definer set search_path = '' as $$
  update public.fin_profiles set avatar_path = p_path where id = auth.uid()
$$;
revoke all on function public.fin_set_avatar(text) from public, anon;
grant execute on function public.fin_set_avatar(text) to authenticated;

-- Storage: employees may upload receipts / avatars; delete own avatar
drop policy if exists fin_receipts_insert on storage.objects;
create policy fin_receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'fin-receipts' and public.fin_can_read());
drop policy if exists fin_receipts_delete on storage.objects;
create policy fin_receipts_delete on storage.objects for delete to authenticated
  using (bucket_id = 'fin-receipts' and (public.fin_can_write() or name like 'avatars/' || auth.uid()::text || '/%'));

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='fin_cost_funds') then
    alter publication supabase_realtime add table public.fin_cost_funds;
  end if;
end $$;
notify pgrst, 'reload schema';
select count(*) as cost_funds from public.fin_cost_funds;
-- Never fail a signup because the username already exists: add a number (rahim, rahim2, rahim3...)
create or replace function public.fin_unique_username(p text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  base text := coalesce(nullif(left(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9._-]', '', 'g'), 26), ''), 'user');
  cand text := base; n int := 1;
begin
  while exists (select 1 from public.fin_profiles where username = cand) loop
    n := n + 1; cand := base || n;
  end loop;
  return cand;
end $$;
revoke all on function public.fin_unique_username(text) from public, anon, authenticated;

create or replace function public.fin_handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.raw_user_meta_data ->> 'app' = 'niduslab_finance' then
    insert into public.fin_profiles (id, username, full_name, role)
    values (new.id, public.fin_unique_username(new.raw_user_meta_data ->> 'username'), coalesce(new.raw_user_meta_data ->> 'name', ''),
      public.fin_pick_role(new.raw_user_meta_data ->> 'invite'))
    on conflict (id) do nothing;
  end if;
  return new;
end $$;

create or replace function public.fin_claim_profile(p_username text, p_name text, p_invite text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.fin_profiles (id, username, full_name, role)
  values (auth.uid(), public.fin_unique_username(p_username), coalesce(p_name, ''), public.fin_pick_role(p_invite))
  on conflict (id) do nothing;
end $$;
revoke all on function public.fin_claim_profile(text, text, text) from public, anon;
grant execute on function public.fin_claim_profile(text, text, text) to authenticated;
notify pgrst, 'reload schema';
select public.fin_unique_username('mdnazzas') as test_should_be_mdnazzas2;

-- Everyone (with or without team code) waits as PENDING until the admin approves and sets a role.
create or replace function public.fin_pick_role(p_code text) returns text
language sql stable security definer set search_path = '' as $$
  select case when not exists (select 1 from public.fin_profiles) then 'ADMIN' else 'PENDING' end
$$;
revoke all on function public.fin_pick_role(text) from public, anon, authenticated;

-- Rename a member: admin can rename anyone, others only themselves. Old expenses follow the new name.
create or replace function public.fin_rename_member(p_id uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare old_name text; n text := left(btrim(coalesce(p_name, '')), 60);
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not (public.fin_is_admin() or p_id = auth.uid()) then raise exception 'not allowed'; end if;
  if n = '' then raise exception 'name is empty'; end if;
  select coalesce(nullif(full_name, ''), username) into old_name from public.fin_profiles where id = p_id;
  if old_name is null then raise exception 'user not found'; end if;
  update public.fin_profiles set full_name = n where id = p_id;
  update public.fin_expenses set employee = n where paid_by = 'EMPLOYEE' and employee = old_name;
end $$;
revoke all on function public.fin_rename_member(uuid, text) from public, anon;
grant execute on function public.fin_rename_member(uuid, text) to authenticated;
-- Super Admin: same as Admin, and the only role that can change Admins / Super Admins.
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'public.fin_profiles'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%role%' loop
    execute format('alter table public.fin_profiles drop constraint %I', c);
  end loop;
end $$;
alter table public.fin_profiles add constraint fin_profiles_role_check check (role in ('PENDING','EMPLOYEE','FINANCE','ADMIN','SUPER_ADMIN'));

create or replace function public.fin_can_read() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.fin_role() in ('EMPLOYEE','FINANCE','ADMIN','SUPER_ADMIN'), false) $$;
create or replace function public.fin_can_write() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.fin_role() in ('FINANCE','ADMIN','SUPER_ADMIN'), false) $$;
create or replace function public.fin_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.fin_role() in ('ADMIN','SUPER_ADMIN'), false) $$;
create or replace function public.fin_is_super() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.fin_role() = 'SUPER_ADMIN', false) $$;
revoke all on function public.fin_is_super() from public, anon;
grant execute on function public.fin_is_super() to authenticated;

-- Admin can manage everyone except Admins / Super Admins and cannot hand out Super Admin.
drop policy if exists fin_profiles_update on public.fin_profiles;
create policy fin_profiles_update on public.fin_profiles for update to authenticated
  using (public.fin_is_super() or (public.fin_is_admin() and role not in ('ADMIN','SUPER_ADMIN')))
  with check (public.fin_is_super() or (public.fin_is_admin() and role <> 'SUPER_ADMIN'));
drop policy if exists fin_profiles_delete on public.fin_profiles;
create policy fin_profiles_delete on public.fin_profiles for delete to authenticated
  using (id <> auth.uid() and (public.fin_is_super() or (public.fin_is_admin() and role not in ('ADMIN','SUPER_ADMIN'))));

-- First ever user becomes Super Admin; everyone else waits as Pending.
create or replace function public.fin_pick_role(p_code text) returns text
language sql stable security definer set search_path = '' as $$
  select case when not exists (select 1 from public.fin_profiles) then 'SUPER_ADMIN' else 'PENDING' end $$;
revoke all on function public.fin_pick_role(text) from public, anon, authenticated;

-- Owner account becomes Super Admin.
update public.fin_profiles set role = 'SUPER_ADMIN' where username = 'mdnazzas';
notify pgrst, 'reload schema';
select username, full_name, role from public.fin_profiles order by created_at;
