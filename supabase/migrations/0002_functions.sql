-- מנוע התורים: זמינות, קביעה, ביטול, כניסה והודעות.
-- הפונקציות בסכמה private מקבלות "מי" ו"מתי" כפרמטרים כדי שאפשר יהיה לבדוק אותן.
-- הפונקציות בסכמה public הן המעטפת שנקראת מהאפליקציה.

-- ───────────────────────── עזרים ─────────────────────────

create or replace function private.is_owner(p_business uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.business_id = p_business and p.role = 'owner'
  );
$$;

-- מנרמל מספר נייד ישראלי ל-+9725XXXXXXXX. מחזיר null אם המספר לא תקין.
create or replace function private.phone_normalize(p text)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when d ~ '^9725[0-9]{8}$' then '+' || d
    when d ~ '^05[0-9]{8}$' then '+972' || substr(d, 2)
    when d ~ '^5[0-9]{8}$' then '+972' || d
    else null
  end
  from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) x;
$$;

-- הופך רשימת [{service_id, qty}] לצילום מלא של הטיפולים, עם משך ומחיר כוללים.
create or replace function private.items_resolve(p_business uuid, p_items jsonb, p_only_active boolean)
returns table (o_items jsonb, o_duration int, o_price int)
language plpgsql stable set search_path = ''
as $$
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'NO_SERVICES';
  end if;
  if jsonb_array_length(p_items) > 10 then
    raise exception 'INVALID_SERVICES';
  end if;

  return query
  with req as (
    select (t.e ->> 'service_id')::uuid as service_id,
           greatest(1, least(20, coalesce((t.e ->> 'qty')::int, 1))) as qty,
           t.ord
    from jsonb_array_elements(p_items) with ordinality as t(e, ord)
  ), joined as (
    select r.ord, s.id, s.name, s.duration_min, s.price, s.price_type,
           case when s.price_type = 'per_unit' then r.qty else 1 end as qty
    from req r
    join public.services s
      on s.id = r.service_id and s.business_id = p_business and (s.active or not p_only_active)
  )
  select jsonb_agg(jsonb_build_object(
           'service_id', j.id, 'name', j.name, 'qty', j.qty,
           'duration_min', j.duration_min * j.qty, 'price', j.price * j.qty,
           'price_type', j.price_type) order by j.ord),
         sum(j.duration_min * j.qty)::int,
         sum(j.price * j.qty)::int
  from joined j
  having count(*) = (select count(*) from req) and count(distinct j.id) = count(*);

  if not found then
    raise exception 'INVALID_SERVICES';
  end if;
exception
  when invalid_text_representation then
    raise exception 'INVALID_SERVICES';
end;
$$;

-- ───────────────────────── זמינות ─────────────────────────

-- מחזיר את כל שעות ההתחלה הפנויות לטיפול באורך נתון, בין שני תאריכים (לפי שעון העסק).
-- בודק: שעות עבודה, חסימות, תורים קיימים + מרווח, התראה מינימלית וחלון הזמנה.
create or replace function private.free_slots(
  p_business uuid, p_duration_min int, p_from date, p_to date, p_now timestamptz)
returns table (slot_start timestamptz)
language sql stable set search_path = ''
as $$
  with cfg as (
    select b.timezone as tz, s.booking_window_days, s.min_notice_min, s.buffer_min, s.slot_step_min,
           (p_now at time zone b.timezone)::date as today
    from public.businesses b
    join public.settings s on s.business_id = b.id
    where b.id = p_business
  ), days as (
    select d::date as day, cfg.tz, cfg.min_notice_min, cfg.buffer_min, cfg.slot_step_min
    from cfg,
         generate_series(greatest(p_from, cfg.today)::timestamp,
                         least(p_to, cfg.today + cfg.booking_window_days)::timestamp,
                         interval '1 day') d
  ), cand as (
    select distinct
           ((days.day + wh.start_time + make_interval(mins => n * days.slot_step_min))
              at time zone days.tz) as s_start,
           days.min_notice_min, days.buffer_min
    from days
    join public.working_hours wh
      on wh.business_id = p_business and wh.weekday = extract(dow from days.day)::int
     -- טווח עבודה שקצר מהטיפול לא מייצר משבצות בכלל
     and extract(epoch from (wh.end_time - wh.start_time))::int / 60 >= p_duration_min
    cross join lateral generate_series(
      0,
      (extract(epoch from (wh.end_time - wh.start_time))::int / 60 - p_duration_min) / days.slot_step_min
    ) n
  )
  select c.s_start
  from cand c
  where c.s_start >= p_now + make_interval(mins => c.min_notice_min)
    and not exists (
      select 1 from public.appointments a
      where a.business_id = p_business and a.status = 'booked'
        and tstzrange(a.start_at - make_interval(mins => c.buffer_min),
                      a.end_at + make_interval(mins => c.buffer_min))
            && tstzrange(c.s_start, c.s_start + make_interval(mins => p_duration_min)))
    and not exists (
      select 1 from public.time_off t
      where t.business_id = p_business
        and tstzrange(t.start_at, t.end_at)
            && tstzrange(c.s_start, c.s_start + make_interval(mins => p_duration_min)))
  order by 1;
$$;

-- ───────────────────────── קביעה וביטול ─────────────────────────

-- השער היחיד לקביעת תור על ידי לקוחה.
create or replace function private.book(
  p_business uuid, p_actor uuid, p_items jsonb, p_start timestamptz, p_now timestamptz)
returns public.appointments
language plpgsql set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_items jsonb;
  v_dur int;
  v_price int;
  v_tz text;
  v_day date;
  v_row public.appointments;
begin
  select * into v_profile from public.profiles where id = p_actor and business_id = p_business;
  if not found then
    raise exception 'NOT_LOGGED_IN';
  end if;
  if coalesce(trim(v_profile.name), '') = '' then
    raise exception 'NAME_REQUIRED';
  end if;

  -- נועל את יומן העסק עד סוף הטרנזקציה, כדי ששתי קביעות בו-זמנית ייבדקו אחת אחרי השנייה.
  perform pg_advisory_xact_lock(hashtextextended(p_business::text, 0));

  select r.o_items, r.o_duration, r.o_price into v_items, v_dur, v_price
  from private.items_resolve(p_business, p_items, true) r;

  if exists (
    select 1 from public.appointments a
    where a.business_id = p_business and a.status = 'booked' and a.end_at > p_now
      and (a.customer_id = p_actor or a.customer_phone = v_profile.phone)
  ) then
    raise exception 'ALREADY_BOOKED';
  end if;

  select b.timezone into v_tz from public.businesses b where b.id = p_business;
  v_day := (p_start at time zone v_tz)::date;
  if not exists (
    select 1 from private.free_slots(p_business, v_dur, v_day, v_day, p_now) f
    where f.slot_start = p_start
  ) then
    raise exception 'SLOT_TAKEN';
  end if;

  insert into public.appointments
    (business_id, customer_id, customer_name, customer_phone, items, total_price,
     start_at, end_at, created_by, created_at)
  values
    (p_business, p_actor, v_profile.name, v_profile.phone, v_items, v_price,
     p_start, p_start + make_interval(mins => v_dur), 'customer', p_now)
  returning * into v_row;
  return v_row;
exception
  when exclusion_violation then
    raise exception 'SLOT_TAKEN';
end;
$$;

-- ביטול. לקוחה יכולה לבטל רק את התור שלה, ורק עד סוף היום שלפני התור.
create or replace function private.cancel(p_id uuid, p_actor uuid, p_now timestamptz)
returns public.appointments
language plpgsql set search_path = ''
as $$
declare
  v_row public.appointments;
  v_tz text;
  v_is_owner boolean;
begin
  select * into v_row from public.appointments where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  v_is_owner := exists (
    select 1 from public.profiles p
    where p.id = p_actor and p.business_id = v_row.business_id and p.role = 'owner');

  if not v_is_owner and v_row.customer_id is distinct from p_actor then
    raise exception 'NOT_FOUND';
  end if;
  if v_row.status <> 'booked' then
    return v_row;
  end if;

  if not v_is_owner then
    select b.timezone into v_tz from public.businesses b where b.id = v_row.business_id;
    if (p_now at time zone v_tz)::date >= (v_row.start_at at time zone v_tz)::date then
      raise exception 'CANCEL_TOO_LATE';
    end if;
  end if;

  update public.appointments
  set status = 'cancelled',
      cancelled_by = case when v_is_owner then 'owner' else 'customer' end,
      cancelled_at = p_now
  where id = p_id
  returning * into v_row;
  return v_row;
end;
$$;

-- תור ידני של בעלת העסק. מותר לחרוג משעות העבודה; אסור רק לחפוף לתור קיים.
create or replace function private.owner_book(
  p_business uuid, p_actor uuid, p_items jsonb, p_start timestamptz,
  p_name text, p_phone text, p_duration_min int, p_now timestamptz)
returns public.appointments
language plpgsql set search_path = ''
as $$
declare
  v_items jsonb;
  v_dur int;
  v_price int;
  v_phone text;
  v_customer uuid;
  v_row public.appointments;
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = p_actor and p.business_id = p_business and p.role = 'owner'
  ) then
    raise exception 'NOT_OWNER';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'NAME_REQUIRED';
  end if;
  if p_start is null then
    raise exception 'INVALID_TIME';
  end if;

  select r.o_items, r.o_duration, r.o_price into v_items, v_dur, v_price
  from private.items_resolve(p_business, p_items, false) r;

  if p_duration_min is not null then
    if p_duration_min < 5 or p_duration_min > 600 then
      raise exception 'INVALID_DURATION';
    end if;
    v_dur := p_duration_min;
  end if;

  if coalesce(trim(p_phone), '') <> '' then
    v_phone := private.phone_normalize(p_phone);
    if v_phone is null then
      raise exception 'INVALID_PHONE';
    end if;
    select p.id into v_customer from public.profiles p
    where p.business_id = p_business and p.phone = v_phone;
  end if;

  insert into public.appointments
    (business_id, customer_id, customer_name, customer_phone, items, total_price,
     start_at, end_at, created_by, created_at)
  values
    (p_business, v_customer, left(trim(p_name), 60), v_phone, v_items, v_price,
     p_start, p_start + make_interval(mins => v_dur), 'owner', p_now)
  returning * into v_row;
  return v_row;
exception
  when exclusion_violation then
    raise exception 'SLOT_TAKEN';
end;
$$;

-- ───────────────────────── מעטפת לאפליקציה ─────────────────────────

create or replace function public.get_free_slots(p_business uuid, p_items jsonb, p_from date, p_to date)
returns table (slot_start timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dur int;
begin
  if (select auth.uid()) is null then
    raise exception 'NOT_LOGGED_IN';
  end if;
  select r.o_duration into v_dur from private.items_resolve(p_business, p_items, true) r;
  return query
    select f.slot_start from private.free_slots(p_business, v_dur, p_from, p_to, now()) f;
end;
$$;

create or replace function public.book_appointment(p_business uuid, p_items jsonb, p_start timestamptz)
returns public.appointments
language sql security definer set search_path = ''
as $$
  select private.book(p_business, (select auth.uid()), p_items, p_start, now());
$$;

create or replace function public.cancel_appointment(p_id uuid)
returns public.appointments
language sql security definer set search_path = ''
as $$
  select private.cancel(p_id, (select auth.uid()), now());
$$;

create or replace function public.owner_book_appointment(
  p_business uuid, p_items jsonb, p_start timestamptz, p_name text,
  p_phone text default null, p_duration_min int default null)
returns public.appointments
language sql security definer set search_path = ''
as $$
  select private.owner_book(p_business, (select auth.uid()), p_items, p_start,
                            p_name, p_phone, p_duration_min, now());
$$;

create or replace function public.set_my_name(p_name text)
returns public.profiles
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.profiles;
begin
  if coalesce(trim(p_name), '') = '' then
    raise exception 'NAME_REQUIRED';
  end if;
  update public.profiles set name = left(trim(p_name), 60)
  where id = (select auth.uid())
  returning * into v_row;
  if not found then
    raise exception 'NOT_LOGGED_IN';
  end if;
  return v_row;
end;
$$;

-- מחליף את כל שעות העבודה בבת אחת. p_rows: [{weekday, start_time, end_time}]
create or replace function public.set_working_hours(p_business uuid, p_rows jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_owner(p_business) then
    raise exception 'NOT_OWNER';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'INVALID_HOURS';
  end if;
  delete from public.working_hours where business_id = p_business;
  insert into public.working_hours (business_id, weekday, start_time, end_time)
  select p_business, (e ->> 'weekday')::smallint, (e ->> 'start_time')::time, (e ->> 'end_time')::time
  from jsonb_array_elements(p_rows) e;
exception
  when check_violation or invalid_text_representation or invalid_datetime_format
       or datetime_field_overflow or not_null_violation then
    raise exception 'INVALID_HOURS';
end;
$$;

-- ───────────────────────── כניסה בקוד חד-פעמי (נקרא רק מהשרת) ─────────────────────────

create or replace function private.otp_hash(p_phone text, p_code text)
returns text
language sql immutable set search_path = ''
as $$
  select encode(sha256(convert_to(p_phone || ':' || p_code, 'UTF8')), 'hex');
$$;

-- שומר קוד חדש. מחזיר 'ok' או 'rate_limited'.
create or replace function public.otp_request(p_business uuid, p_phone text, p_code text)
returns text
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.otp_codes where created_at < now() - interval '2 days';

  if (select count(*) from public.otp_codes
      where phone = p_phone and created_at > now() - interval '15 minutes') >= 3
     or (select count(*) from public.otp_codes
         where phone = p_phone and created_at > now() - interval '1 day') >= 10
     or (select count(*) from public.otp_codes
         where created_at > now() - interval '1 hour') >= 200 then
    return 'rate_limited';
  end if;

  insert into public.otp_codes (business_id, phone, code_hash, expires_at)
  values (p_business, p_phone, private.otp_hash(p_phone, p_code), now() + interval '10 minutes');
  return 'ok';
end;
$$;

-- בודק קוד מול הקוד האחרון שנשלח. עד 5 ניסיונות לכל קוד.
create or replace function public.otp_verify(p_business uuid, p_phone text, p_code text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.otp_codes;
begin
  select * into v_row from public.otp_codes
  where business_id = p_business and phone = p_phone
    and consumed_at is null and expires_at > now()
  order by created_at desc, id desc
  limit 1
  for update;

  if not found or v_row.attempts >= 5 then
    return false;
  end if;

  if v_row.code_hash = private.otp_hash(p_phone, p_code) then
    update public.otp_codes set consumed_at = now() where id = v_row.id;
    return true;
  end if;

  update public.otp_codes set attempts = attempts + 1 where id = v_row.id;
  return false;
end;
$$;

-- יוצר (או מעדכן) פרופיל אחרי כניסה מוצלחת, ומשייך אליו תורים ידניים שנקבעו לאותו טלפון.
create or replace function public.profile_ensure(p_user uuid, p_business uuid, p_phone text)
returns public.profiles
language plpgsql security definer set search_path = ''
as $$
declare
  v_role text;
  v_row public.profiles;
begin
  v_role := case when exists (
    select 1 from public.owners o where o.business_id = p_business and o.phone = p_phone
  ) then 'owner' else 'customer' end;

  insert into public.profiles (id, business_id, phone, role)
  values (p_user, p_business, p_phone, v_role)
  on conflict (id) do update set role = excluded.role
  returning * into v_row;

  update public.appointments
  set customer_id = p_user
  where business_id = p_business and customer_phone = p_phone and customer_id is null;

  return v_row;
end;
$$;

-- ───────────────────────── הודעות ─────────────────────────

-- מעיר את פונקציית השליחה בשרת (אם pg_net מותקן וההגדרות קיימות). לא מפיל אף פעם את הפעולה שקראה לו.
create or replace function private.dispatch_ping()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  if to_regnamespace('net') is null then
    return;
  end if;
  select value into v_url from private.app_config where key = 'dispatch_url';
  select value into v_secret from private.app_config where key = 'dispatch_secret';
  if v_url is null or v_secret is null then
    return;
  end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3)'
    using v_url, '{}'::jsonb,
          jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-secret', v_secret);
exception
  when others then
    raise warning 'dispatch_ping failed: %', sqlerrm;
end;
$$;

-- כל תור חדש או ביטול מכניס הודעות לתור היוצא.
create or replace function private.appointments_notify()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.status = 'booked' then
    if new.customer_phone is not null and new.start_at > now() then
      insert into public.notifications (business_id, appointment_id, kind)
      values (new.business_id, new.id, 'customer_confirm');
    end if;
    if new.created_by = 'customer' then
      insert into public.notifications (business_id, appointment_id, kind)
      values (new.business_id, new.id, 'owner_booked');
    end if;
    perform private.dispatch_ping();
  elsif tg_op = 'UPDATE' and old.status = 'booked' and new.status = 'cancelled' then
    if new.cancelled_by = 'customer' then
      insert into public.notifications (business_id, appointment_id, kind)
      values (new.business_id, new.id, 'owner_cancelled');
      perform private.dispatch_ping();
    end if;
  end if;
  return null;
end;
$$;

create trigger appointments_notify_trg
after insert or update of status on public.appointments
for each row execute function private.appointments_notify();

-- מכניס לתור תזכורות לתורים של מחר, מרגע ששעת התזכורת עברה. כל תור מקבל תזכורת אחת.
-- תור שנקבע אחרי שעת התזכורת לא מקבל תזכורת (הלקוחה קיבלה אישור זה עתה).
create or replace function private.reminders_enqueue(p_now timestamptz)
returns int
language plpgsql set search_path = ''
as $$
declare
  v_count int;
begin
  with due as (
    update public.appointments a
    set reminder_sent_at = p_now
    from public.businesses b, public.settings s
    where b.id = a.business_id and s.business_id = a.business_id
      and a.status = 'booked'
      and a.reminder_sent_at is null
      and a.customer_phone is not null
      and (a.start_at at time zone b.timezone)::date = (p_now at time zone b.timezone)::date + 1
      and (p_now at time zone b.timezone)::time >= s.reminder_time
      and a.created_at < (((p_now at time zone b.timezone)::date + s.reminder_time) at time zone b.timezone)
    returning a.business_id, a.id
  ), ins as (
    insert into public.notifications (business_id, appointment_id, kind)
    select d.business_id, d.id, 'customer_reminder' from due d
    returning 1
  )
  select count(*) into v_count from ins;
  return v_count;
end;
$$;

-- רץ כל כמה דקות (pg_cron): מכניס תזכורות ומעיר את פונקציית השליחה.
create or replace function private.tick()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.reminders_enqueue(now());
  perform private.dispatch_ping();
end;
$$;

create or replace function private.hebrew_day(p_local timestamp)
returns text
language sql immutable set search_path = ''
as $$
  select (array['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'])[extract(dow from p_local)::int + 1];
$$;

-- מושך הודעות שממתינות לשליחה ומסמן אותן "בשליחה". נקרא רק מהשרת.
create or replace function public.notifications_claim(p_limit int default 20)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_result jsonb;
begin
  with picked as (
    select n.id from public.notifications n
    where n.created_at > now() - interval '1 day'
      and (n.status = 'pending'
           or (n.status = 'sending' and n.claimed_at < now() - interval '10 minutes')
           or (n.status = 'failed' and n.attempts < 3 and n.claimed_at < now() - interval '4 minutes'))
    order by n.id
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update skip locked
  ), upd as (
    update public.notifications n
    set status = 'sending', attempts = n.attempts + 1, claimed_at = now()
    from picked
    where n.id = picked.id
    returning n.id, n.kind, n.business_id, n.appointment_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', u.id,
    'kind', u.kind,
    'business_id', u.business_id,
    'business_name', b.name,
    'appointment_id', a.id,
    'appointment_status', a.status,
    'customer_name', a.customer_name,
    'customer_phone', a.customer_phone,
    'services_text', (select string_agg(
        (i ->> 'name') || case when (i ->> 'qty')::int > 1 then ' ×' || (i ->> 'qty') else '' end,
        ', ') from jsonb_array_elements(a.items) i),
    'day_text', 'יום ' || private.hebrew_day(a.start_at at time zone b.timezone),
    'date_text', to_char(a.start_at at time zone b.timezone, 'DD.MM'),
    'time_text', to_char(a.start_at at time zone b.timezone, 'HH24:MI'),
    'local_date', to_char(a.start_at at time zone b.timezone, 'YYYY-MM-DD')
  ) order by u.id), '[]'::jsonb)
  into v_result
  from upd u
  join public.businesses b on b.id = u.business_id
  left join public.appointments a on a.id = u.appointment_id;
  return v_result;
end;
$$;

create or replace function public.notification_done(p_id bigint, p_status text, p_error text default null)
returns void
language sql security definer set search_path = ''
as $$
  update public.notifications
  set status = p_status,
      error = left(p_error, 500),
      sent_at = case when p_status = 'sent' then now() else sent_at end
  where id = p_id and p_status in ('sent', 'skipped', 'failed');
$$;

create or replace function public.app_config_get()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from private.app_config;
$$;

-- בעלת העסק שולחת לעצמה התראת בדיקה.
create or replace function public.push_test(p_business uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_owner(p_business) then
    raise exception 'NOT_OWNER';
  end if;
  insert into public.notifications (business_id, kind) values (p_business, 'owner_test');
  perform private.dispatch_ping();
end;
$$;
