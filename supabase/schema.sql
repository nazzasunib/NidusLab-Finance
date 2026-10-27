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
