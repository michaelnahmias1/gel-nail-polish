-- שער השרת: הפונקציות שהשרת ב-Vercel קורא להן.
-- במקום מפתח service_role, השרת מזדהה בסוד משותף שנשמר ב-private.app_config (dispatch_secret).
-- כך כל הלוגיקה הרגישה נשארת במסד, והשרת לא צריך שום מפתח-על.

create extension if not exists pgcrypto with schema extensions;

create or replace function private.server_ok(p_secret text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(length(p_secret), 0) >= 32 and exists (
    select 1 from private.app_config where key = 'dispatch_secret' and value = p_secret);
$$;

create or replace function private.server_check(p_secret text)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.server_ok(p_secret) then
    raise exception 'FORBIDDEN';
  end if;
end;
$$;

-- כתובת הדוא"ל הפנימית של משתמשת. לא נשלח אליה כלום; היא רק מזהה כניסה ב-Supabase Auth.
create or replace function private.login_email(p_phone text)
returns text
language sql immutable set search_path = ''
as $$
  select 'p' || regexp_replace(p_phone, '[^0-9]', '', 'g') || '@users.gel-nail-polish.app';
$$;

-- שלב 1 בכניסה: שומר קוד חד-פעמי. השרת שולח את הקוד בוואטסאפ.
-- מחזיר {status: ok | rate_limited | invalid_phone | no_business, phone}
create or replace function public.srv_login_start(p_secret text, p_slug text, p_phone text, p_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_business uuid;
  v_phone text;
  v_status text;
begin
  perform private.server_check(p_secret);
  select id into v_business from public.businesses where slug = p_slug;
  if v_business is null then
    return jsonb_build_object('status', 'no_business');
  end if;
  v_phone := private.phone_normalize(p_phone);
  if v_phone is null then
    return jsonb_build_object('status', 'invalid_phone');
  end if;
  if p_code !~ '^[0-9]{4,8}$' then
    raise exception 'INVALID_CODE_FORMAT';
  end if;
  v_status := public.otp_request(v_business, v_phone, p_code);
  return jsonb_build_object('status', v_status, 'phone', v_phone);
end;
$$;

-- שלב 2 בכניסה: בודק את הקוד. אם נכון — יוצר (או מאתר) משתמשת ב-Supabase Auth,
-- קובע לה סיסמה אקראית חדשה ומחזיר אותה לשרת, שמחליף אותה מיד בחיבור (session).
-- הסיסמה לא נשמרת בשום מקום חוץ מהגיבוב שלה.
create or replace function public.srv_login_finish(p_secret text, p_slug text, p_phone text, p_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_business uuid;
  v_phone text;
  v_email text;
  v_password text;
  v_user uuid;
  v_profile public.profiles;
begin
  perform private.server_check(p_secret);
  select id into v_business from public.businesses where slug = p_slug;
  v_phone := private.phone_normalize(p_phone);
  if v_business is null or v_phone is null then
    return jsonb_build_object('ok', false);
  end if;
  if not public.otp_verify(v_business, v_phone, coalesce(p_code, '')) then
    return jsonb_build_object('ok', false);
  end if;

  v_email := private.login_email(v_phone);
  v_password := encode(extensions.gen_random_bytes(24), 'hex');

  select id into v_user from auth.users where email = v_email;
  if v_user is null then
    v_user := gen_random_uuid();
    insert into auth.users
      (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
       confirmation_token, recovery_token, email_change_token_new, email_change)
    values
      ('00000000-0000-0000-0000-000000000000', v_user, 'authenticated', 'authenticated', v_email,
       extensions.crypt(v_password, extensions.gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
       '', '', '', '');
    insert into auth.identities
      (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values
      (v_user::text, v_user,
       jsonb_build_object('sub', v_user::text, 'email', v_email, 'email_verified', true),
       'email', now(), now(), now());
  else
    update auth.users
    set encrypted_password = extensions.crypt(v_password, extensions.gen_salt('bf')),
        updated_at = now()
    where id = v_user;
  end if;

  v_profile := public.profile_ensure(v_user, v_business, v_phone);

  return jsonb_build_object(
    'ok', true, 'email', v_email, 'password', v_password,
    'role', v_profile.role, 'has_name', coalesce(trim(v_profile.name), '') <> '');
end;
$$;

-- משיכת הודעות לשליחה, סיום הודעה והגדרות — עבור פונקציית השליחה בשרת.
create or replace function public.srv_notifications_claim(p_secret text, p_limit int default 20)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.server_check(p_secret);
  return public.notifications_claim(p_limit);
end;
$$;

create or replace function public.srv_notification_done(p_secret text, p_id bigint, p_status text, p_error text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.server_check(p_secret);
  perform public.notification_done(p_id, p_status, p_error);
end;
$$;

create or replace function public.srv_config(p_secret text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.server_check(p_secret);
  return public.app_config_get();
end;
$$;

-- מנויי הפוש של בעלות העסק.
create or replace function public.srv_owner_push_targets(p_secret text, p_business uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.server_check(p_secret);
  return coalesce((
    select jsonb_agg(jsonb_build_object('endpoint', ps.endpoint, 'p256dh', ps.p256dh, 'auth', ps.auth))
    from public.push_subscriptions ps
    join public.profiles p on p.id = ps.profile_id
    where ps.business_id = p_business and p.role = 'owner'), '[]'::jsonb);
end;
$$;

-- מנוי שהדפדפן ביטל (שגיאה 404/410) נמחק.
create or replace function public.srv_push_remove(p_secret text, p_endpoint text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.server_check(p_secret);
  delete from public.push_subscriptions where endpoint = p_endpoint;
end;
$$;

-- המפתח הציבורי של הפוש — גלוי לכולן (הוא ציבורי מעצם הגדרתו).
create or replace function public.push_public_key()
returns text
language sql stable security definer set search_path = ''
as $$
  select value from private.app_config where key = 'vapid_public';
$$;

-- בעלת העסק נרשמת: מי שמחוברת ומזינה את קוד ההקמה הופכת לבעלת העסק.
-- הקוד חד-פעמי ונמחק מיד אחרי השימוש.
create or replace function public.claim_owner(p_business uuid, p_code text)
returns public.profiles
language plpgsql security definer set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  select * into v_profile from public.profiles
  where id = (select auth.uid()) and business_id = p_business;
  if not found then
    raise exception 'NOT_LOGGED_IN';
  end if;
  if not exists (
    select 1 from private.app_config
    where key = 'owner_claim_code' and length(value) >= 8 and value = trim(coalesce(p_code, ''))
  ) then
    raise exception 'BAD_CLAIM_CODE';
  end if;

  insert into public.owners (business_id, phone) values (p_business, v_profile.phone)
  on conflict do nothing;
  update public.profiles set role = 'owner' where id = v_profile.id returning * into v_profile;
  delete from private.app_config where key = 'owner_claim_code';
  return v_profile;
end;
$$;

-- סוגרים הכול, ופותחים רק את מה שצריך.
revoke all on function public.srv_login_start(text, text, text, text) from public, anon, authenticated;
revoke all on function public.srv_login_finish(text, text, text, text) from public, anon, authenticated;
revoke all on function public.srv_notifications_claim(text, int) from public, anon, authenticated;
revoke all on function public.srv_notification_done(text, bigint, text, text) from public, anon, authenticated;
revoke all on function public.srv_config(text) from public, anon, authenticated;
revoke all on function public.srv_owner_push_targets(text, uuid) from public, anon, authenticated;
revoke all on function public.srv_push_remove(text, text) from public, anon, authenticated;
revoke all on function public.push_public_key() from public, anon, authenticated;
revoke all on function public.claim_owner(uuid, text) from public, anon, authenticated;
revoke all on function private.server_ok(text) from public, anon, authenticated;
revoke all on function private.server_check(text) from public, anon, authenticated;
revoke all on function private.login_email(text) from public, anon, authenticated;

-- השרת מגיע עם המפתח הציבורי (anon), ולכן פונקציות השער פתוחות ל-anon — הסוד הוא השומר.
grant execute on function public.srv_login_start(text, text, text, text) to anon, authenticated, service_role;
grant execute on function public.srv_login_finish(text, text, text, text) to anon, authenticated, service_role;
grant execute on function public.srv_notifications_claim(text, int) to anon, authenticated, service_role;
grant execute on function public.srv_notification_done(text, bigint, text, text) to anon, authenticated, service_role;
grant execute on function public.srv_config(text) to anon, authenticated, service_role;
grant execute on function public.srv_owner_push_targets(text, uuid) to anon, authenticated, service_role;
grant execute on function public.srv_push_remove(text, text) to anon, authenticated, service_role;
grant execute on function public.push_public_key() to anon, authenticated, service_role;
grant execute on function public.claim_owner(uuid, text) to authenticated;
