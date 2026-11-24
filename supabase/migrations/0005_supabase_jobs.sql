-- חלק שתלוי ב-Supabase: תזמון (pg_cron) וקריאה לפונקציית השליחה (pg_net).
-- כל השאר רץ על כל Postgres רגיל.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- כל 5 דקות: מכניס תזכורות שהגיע זמנן ומעיר את פונקציית השליחה.
select cron.schedule('gel-tick', '*/5 * * * *', $$select private.tick()$$);
