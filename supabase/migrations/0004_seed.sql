-- נתוני פתיחה: עסק אחד, מחירון התחלתי ושעות עבודה. הכול ניתן לעריכה במסך ההגדרות.

insert into public.businesses (slug, name) values ('main', 'סטודיו לק ג׳ל');

insert into public.settings (business_id)
select id from public.businesses where slug = 'main';

insert into public.services (business_id, name, duration_min, price, price_type, sort_order)
select b.id, v.name, v.duration_min, v.price, v.price_type, v.sort_order
from public.businesses b,
     (values
       ('לק ג׳ל אנטומי', 50, 130, 'fixed', 1),
       ('לק ג׳ל רגליים', 40, 130, 'fixed', 2),
       ('הסרת לק ג׳ל', 10, 30, 'fixed', 3),
       ('הסרת לק ג׳ל ומניקור', 15, 40, 'fixed', 4),
       ('בנייה בטיפס ג׳ל', 60, 250, 'fixed', 5),
       -- מחיר ומשך לכל אצבע; הלקוחה בוחרת כמה אצבעות.
       ('השלמת ציפורן', 5, 10, 'per_unit', 6)
     ) as v(name, duration_min, price, price_type, sort_order)
where b.slug = 'main';

-- ראשון–חמישי 09:00–19:00, שישי 09:00–13:00, שבת סגור.
insert into public.working_hours (business_id, weekday, start_time, end_time)
select b.id, d, '09:00', case when d = 5 then '13:00' else '19:00' end::time
from public.businesses b, generate_series(0, 5) d
where b.slug = 'main';
