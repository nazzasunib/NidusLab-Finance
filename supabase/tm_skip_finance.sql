-- OPTIONAL (run yourself): Task Management ignores logins created by NidusLab Finance.
-- Only adds the first "if" line; the rest is the current tm_handle_new_user unchanged.
CREATE OR REPLACE FUNCTION public.tm_handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
begin
  if new.raw_user_meta_data ->> 'app' = 'niduslab_finance' then return new; end if;
  insert into public.tm_profiles (id, full_name, email)
  values (new.id, left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(coalesce(new.email, ''), '@', 1)), 80), coalesce(new.email, ''))
  on conflict (id) do nothing;
  return new;
end; $function$;
