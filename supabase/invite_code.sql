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
