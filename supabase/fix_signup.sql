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
