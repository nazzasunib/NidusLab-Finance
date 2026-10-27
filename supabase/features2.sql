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
