-- הרשאות ופרטיות.
-- עיקרון: לקוחה רואה רק את התורים שלה. כתיבת תורים רק דרך הפונקציות.
-- owners, otp_codes ו-notifications סגורות לגמרי (רק השרת ניגש אליהן).

alter table public.businesses enable row level security;
alter table public.settings enable row level security;
alter table public.owners enable row level security;
alter table public.services enable row level security;
alter table public.working_hours enable row level security;
alter table public.time_off enable row level security;
alter table public.profiles enable row level security;
alter table public.appointments enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.otp_codes enable row level security;
alter table public.notifications enable row level security;

-- מתחילים מאפס הרשאות, ונותנים רק את מה שצריך.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema private to anon, authenticated, service_role;
grant execute on function private.is_owner(uuid) to anon, authenticated, service_role;

grant all on all tables in schema public to service_role;
grant usage on all sequences in schema public to service_role;

-- פרטי העסק והמחירון: גלויים לכולן.
grant select on public.businesses, public.settings, public.services to anon, authenticated;
create policy businesses_read on public.businesses for select to anon, authenticated using (true);
create policy settings_read on public.settings for select to anon, authenticated using (true);
create policy services_read on public.services for select to anon, authenticated
  using (active or private.is_owner(business_id));

-- בעלת העסק עורכת את ההגדרות, השם והמחירון.
grant update (name) on public.businesses to authenticated;
create policy businesses_owner_update on public.businesses for update to authenticated
  using (private.is_owner(id)) with check (private.is_owner(id));

grant update (booking_window_days, min_notice_min, buffer_min, slot_step_min, reminder_time,
              address, contact_phone, updated_at) on public.settings to authenticated;
create policy settings_owner_update on public.settings for update to authenticated
  using (private.is_owner(business_id)) with check (private.is_owner(business_id));

grant insert, update, delete on public.services to authenticated;
create policy services_owner_insert on public.services for insert to authenticated
  with check (private.is_owner(business_id));
create policy services_owner_update on public.services for update to authenticated
  using (private.is_owner(business_id)) with check (private.is_owner(business_id));
create policy services_owner_delete on public.services for delete to authenticated
  using (private.is_owner(business_id));

-- שעות עבודה: בעלת העסק בלבד (לקוחות מקבלות רק שעות פנויות דרך get_free_slots).
grant select on public.working_hours to authenticated;
create policy working_hours_owner_read on public.working_hours for select to authenticated
  using (private.is_owner(business_id));

-- חסימות וחופשות: בעלת העסק בלבד.
grant select, insert, update, delete on public.time_off to authenticated;
create policy time_off_owner_read on public.time_off for select to authenticated
  using (private.is_owner(business_id));
create policy time_off_owner_insert on public.time_off for insert to authenticated
  with check (private.is_owner(business_id));
create policy time_off_owner_update on public.time_off for update to authenticated
  using (private.is_owner(business_id)) with check (private.is_owner(business_id));
create policy time_off_owner_delete on public.time_off for delete to authenticated
  using (private.is_owner(business_id));

-- פרופיל: כל אחת רואה את שלה; בעלת העסק רואה את כולן. עדכון שם רק דרך set_my_name.
grant select on public.profiles to authenticated;
create policy profiles_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.is_owner(business_id));

-- תורים: לקוחה רואה רק את שלה; בעלת העסק רואה הכול. כתיבה רק דרך הפונקציות.
grant select on public.appointments to authenticated;
create policy appointments_read on public.appointments for select to authenticated
  using (customer_id = (select auth.uid()) or private.is_owner(business_id));

-- מנויי פוש: בעלת העסק מנהלת את שלה.
grant select, insert, update, delete on public.push_subscriptions to authenticated;
create policy push_read on public.push_subscriptions for select to authenticated
  using (profile_id = (select auth.uid()));
create policy push_insert on public.push_subscriptions for insert to authenticated
  with check (profile_id = (select auth.uid()) and private.is_owner(business_id));
create policy push_update on public.push_subscriptions for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()) and private.is_owner(business_id));
create policy push_delete on public.push_subscriptions for delete to authenticated
  using (profile_id = (select auth.uid()));

-- פונקציות לאפליקציה (משתמשת מחוברת בלבד).
grant execute on function public.get_free_slots(uuid, jsonb, date, date) to authenticated;
grant execute on function public.book_appointment(uuid, jsonb, timestamptz) to authenticated;
grant execute on function public.cancel_appointment(uuid) to authenticated;
grant execute on function public.owner_book_appointment(uuid, jsonb, timestamptz, text, text, int) to authenticated;
grant execute on function public.set_my_name(text) to authenticated;
grant execute on function public.set_working_hours(uuid, jsonb) to authenticated;
grant execute on function public.push_test(uuid) to authenticated;

-- פונקציות לשרת בלבד.
grant execute on function public.otp_request(uuid, text, text) to service_role;
grant execute on function public.otp_verify(uuid, text, text) to service_role;
grant execute on function public.profile_ensure(uuid, uuid, text) to service_role;
grant execute on function public.notifications_claim(int) to service_role;
grant execute on function public.notification_done(bigint, text, text) to service_role;
grant execute on function public.app_config_get() to service_role;
grant execute on function public.get_free_slots(uuid, jsonb, date, date) to service_role;
