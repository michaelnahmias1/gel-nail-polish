// בדיקות אוטומטיות למנוע התורים, מול Postgres אמיתי שרץ מקומית.
// מריצות את אותן מיגרציות שרצות בפרויקט האמיתי (חוץ מ-0005, שתלוי ב-Supabase).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const dataDir = path.join(here, '.pgdata');
const PORT = 54329;

let server;
let db;      // חיבור ראשי (superuser)
let db2;     // חיבור שני, לבדיקת קביעות בו-זמניות
let biz;     // מזהה העסק
let svc;     // שם טיפול -> מזהה

const OWNER = '00000000-0000-4000-8000-000000000001';
const DANA = '00000000-0000-4000-8000-000000000002';
const NOA = '00000000-0000-4000-8000-000000000003';

// "עכשיו" של הבדיקות: יום ראשון 3.1.2027, 08:00 בבוקר שעון ישראל (שעון חורף, UTC+2).
const NOW = '2027-01-03T08:00:00+02:00';

const q = async (sql, params = [], client = db) => (await client.query(sql, params)).rows;
const one = async (sql, params = [], client = db) => (await q(sql, params, client))[0];

const items = (...names) => JSON.stringify(names.map((n) =>
  typeof n === 'string' ? { service_id: svc[n] } : { service_id: svc[n[0]], qty: n[1] }));

const slotsLocal = async (duration, from, to, now = NOW) =>
  (await q(
    `select to_char(slot_start at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') as t
     from private.free_slots($1, $2, $3, $4, $5)`, [biz, duration, from, to ?? from, now])).map((r) => r.t);

const book = (actor, itemsJson, start, now = NOW, client = db) =>
  one('select * from private.book($1, $2, $3, $4, $5)', [biz, actor, itemsJson, start, now], client);

const rejects = (promise, message) => assert.rejects(promise, (e) => {
  assert.match(e.message, message);
  return true;
});

// מריץ פעולה בתור משתמשת מחוברת (או אורחת), כמו שה-API של Supabase מריץ.
async function asRole(role, uid, fn) {
  await db.query('begin');
  try {
    await db.query(`set local role ${role}`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? '']);
    const result = await fn();
    await db.query('commit');
    return result;
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}
const asUser = (uid, fn) => asRole('authenticated', uid, fn);

before(async () => {
  rmSync(dataDir, { recursive: true, force: true });
  server = new EmbeddedPostgres({
    databaseDir: dataDir, port: PORT, user: 'postgres', password: 'password', persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {}, onError: () => {},
  });
  await server.initialise();
  await server.start();
  await server.createDatabase('gel');
  const conn = { host: 'localhost', port: PORT, user: 'postgres', password: 'password', database: 'gel' };
  db = new pg.Client(conn);
  db2 = new pg.Client(conn);
  await db.connect();
  await db2.connect();

  await db.query(readFileSync(path.join(here, 'shim.sql'), 'utf8'));
  for (const f of ['0001_schema.sql', '0002_functions.sql', '0003_security.sql', '0004_seed.sql', '0006_server_gate.sql']) {
    await db.query(readFileSync(path.join(root, 'supabase', 'migrations', f), 'utf8'));
  }

  biz = (await one(`select id from public.businesses where slug = 'main'`)).id;
  svc = Object.fromEntries((await q('select id, name from public.services')).map((r) => [r.name, r.id]));

  await db.query(`insert into auth.users (id) values ($1), ($2), ($3)`, [OWNER, DANA, NOA]);
  await db.query(`insert into public.owners (business_id, phone) values ($1, '+972500000000')`, [biz]);
  await db.query(
    `insert into public.profiles (id, business_id, phone, name, role) values
       ($2, $1, '+972500000000', 'בעלת העסק', 'owner'),
       ($3, $1, '+972501111111', 'דנה', 'customer'),
       ($4, $1, '+972502222222', 'נועה', 'customer')`, [biz, OWNER, DANA, NOA]);
});

after(async () => {
  await db?.end();
  await db2?.end();
  await server?.stop();
});

beforeEach(async () => {
  await db.query('truncate public.notifications, public.appointments, public.time_off, public.otp_codes');
  await db.query(
    `update public.settings set booking_window_days = 30, min_notice_min = 120, buffer_min = 10,
       slot_step_min = 30, reminder_time = '10:00' where business_id = $1`, [biz]);
  await db.query('delete from public.working_hours where business_id = $1', [biz]);
  await db.query(
    `insert into public.working_hours (business_id, weekday, start_time, end_time)
     select $1, d, '09:00', case when d = 5 then '13:00' else '19:00' end::time from generate_series(0, 5) d`, [biz]);
  await db.query('update public.services set active = true');
});

// ───────────────────────── מנוע הזמינות ─────────────────────────

test('זמינות: יום עבודה רגיל מייצר משבצות לפי שעות העבודה והקפיצה', async () => {
  const s = await slotsLocal(50, '2027-01-04'); // יום שני, 09:00–19:00, טיפול 50 דק׳
  assert.equal(s[0], '2027-01-04 09:00');
  assert.equal(s.at(-1), '2027-01-04 18:00'); // 18:00 + 50 דק׳ נכנס; 18:30 כבר לא
  assert.equal(s.length, 19);
});

test('זמינות: יום שישי קצר, שבת סגורה', async () => {
  const fri = await slotsLocal(50, '2027-01-08');
  assert.equal(fri[0], '2027-01-08 09:00');
  assert.equal(fri.at(-1), '2027-01-08 12:00');
  assert.deepEqual(await slotsLocal(50, '2027-01-09'), []);
});

test('זמינות: טיפול ארוך מטווח העבודה לא מקבל אף משבצת', async () => {
  await db.query(`update public.working_hours set end_time = '09:30' where weekday = 1`);
  assert.deepEqual(await slotsLocal(50, '2027-01-04'), []);
  assert.deepEqual(await slotsLocal(30, '2027-01-04'), ['2027-01-04 09:00']);
});

test('זמינות: הפסקה באמצע היום (שני טווחים)', async () => {
  await db.query(`update public.working_hours set end_time = '13:00' where weekday = 1`);
  await db.query(
    `insert into public.working_hours (business_id, weekday, start_time, end_time) values ($1, 1, '16:00', '19:00')`, [biz]);
  const s = await slotsLocal(60, '2027-01-04');
  assert.ok(s.includes('2027-01-04 12:00'));
  assert.ok(!s.includes('2027-01-04 12:30'), 'טיפול של שעה לא נכנס לפני ההפסקה');
  assert.ok(!s.includes('2027-01-04 14:00'));
  assert.ok(s.includes('2027-01-04 16:00'));
});

test('זמינות: תור קיים חוסם את הזמן שלו ואת המרווח סביבו', async () => {
  await book(DANA, items('לק ג׳ל אנטומי'), '2027-01-04T10:00:00+02:00'); // 10:00–10:50, מרווח 10
  const s = await slotsLocal(50, '2027-01-04');
  assert.ok(s.includes('2027-01-04 09:00'), '09:00–09:50 + מרווח 10 = בדיוק עד 10:00');
  assert.ok(!s.includes('2027-01-04 09:30'));
  assert.ok(!s.includes('2027-01-04 10:00'));
  assert.ok(!s.includes('2027-01-04 10:30'));
  assert.ok(s.includes('2027-01-04 11:00'), '10:50 + מרווח 10 = 11:00');
});

test('זמינות: חסימה (חופשה) מסתירה את המשבצות שבתוכה', async () => {
  await db.query(
    `insert into public.time_off (business_id, start_at, end_at, reason)
     values ($1, '2027-01-04T12:00:00+02:00', '2027-01-05T00:00:00+02:00', 'סידורים')`, [biz]);
  const s = await slotsLocal(50, '2027-01-04');
  assert.equal(s.at(-1), '2027-01-04 11:00', '11:00–11:50 נכנס, 11:30–12:20 כבר נוגע בחסימה');
  assert.equal((await slotsLocal(50, '2027-01-05')).length, 19, 'למחרת הכול פתוח');
});

test('זמינות: התראה מינימלית', async () => {
  // עכשיו 08:00 ביום ראשון, התראה של שעתיים -> המשבצת הראשונה היום היא 10:00
  const s = await slotsLocal(50, '2027-01-03');
  assert.equal(s[0], '2027-01-03 10:00');
  await db.query('update public.settings set min_notice_min = 0');
  assert.equal((await slotsLocal(50, '2027-01-03'))[0], '2027-01-03 09:00');
  // משבצות שעברו לא מוצגות גם בלי התראה מינימלית
  const later = await slotsLocal(50, '2027-01-03', null, '2027-01-03T12:10:00+02:00');
  assert.equal(later[0], '2027-01-03 12:30');
});

test('זמינות: חלון ההזמנה מגביל כמה רחוק אפשר לקבוע', async () => {
  await db.query('update public.settings set booking_window_days = 7');
  const s = await slotsLocal(50, '2027-01-01', '2027-03-01');
  assert.equal(s[0].slice(0, 10), '2027-01-03', 'לא מציגים ימים שעברו');
  assert.equal(s.at(-1).slice(0, 10), '2027-01-10', 'היום + 7 ימים');
});

test('זמינות: קפיצות של רבע שעה', async () => {
  await db.query('update public.settings set slot_step_min = 15');
  const s = await slotsLocal(50, '2027-01-04');
  assert.deepEqual(s.slice(0, 3), ['2027-01-04 09:00', '2027-01-04 09:15', '2027-01-04 09:30']);
  assert.equal(s.at(-1), '2027-01-04 18:00');
});

test('שעון קיץ: המשבצות נשארות בשעה הנכונה משני צידי המעבר', async () => {
  await db.query('update public.settings set booking_window_days = 365');
  const utc = async (day) => (await one(
    `select to_char(min(slot_start) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as t,
            to_char(min(slot_start) at time zone 'Asia/Jerusalem', 'HH24:MI') as local, count(*)::int as n
     from private.free_slots($1, 50, $2, $2, $3)`, [biz, day, NOW]));

  // מעבר לשעון קיץ: יום שישי 26.3.2027 ב-02:00
  const thu = await utc('2027-03-25');
  const fri = await utc('2027-03-26');
  assert.equal(thu.t, '2027-03-25 07:00', 'חורף: 09:00 = 07:00 UTC');
  assert.equal(fri.t, '2027-03-26 06:00', 'קיץ: 09:00 = 06:00 UTC');
  assert.equal(thu.local, '09:00');
  assert.equal(fri.local, '09:00');
  assert.equal(fri.n, 7, 'יום שישי 09:00–13:00, אותה כמות משבצות');

  // חזרה לשעון חורף: יום ראשון 31.10.2027 ב-02:00
  const before = await utc('2027-10-29');
  const sun = await utc('2027-10-31');
  assert.equal(before.t, '2027-10-29 06:00');
  assert.equal(sun.t, '2027-10-31 07:00');
  assert.equal(sun.local, '09:00');
  assert.equal(sun.n, 19, 'יום ארוך של 25 שעות לא מוסיף ולא מוריד משבצות');
});

test('שעון קיץ: תור ביום המעבר נשמר באורך הנכון ובשעה הנכונה', async () => {
  await db.query('update public.settings set booking_window_days = 365');
  const a = await book(DANA, items('לק ג׳ל אנטומי'), '2027-03-26T09:00:00+03:00');
  const r = await one(
    `select to_char(start_at at time zone 'Asia/Jerusalem', 'HH24:MI') s,
            to_char(end_at at time zone 'Asia/Jerusalem', 'HH24:MI') e from public.appointments where id = $1`, [a.id]);
  assert.deepEqual(r, { s: '09:00', e: '09:50' });
});

// ───────────────────────── קביעה ─────────────────────────

test('קביעה: נקבע מיד, עם צילום הטיפולים, המשך והמחיר', async () => {
  const a = await book(DANA, items('הסרת לק ג׳ל', 'לק ג׳ל אנטומי'), '2027-01-04T10:00:00+02:00');
  assert.equal(a.status, 'booked');
  assert.equal(a.created_by, 'customer');
  assert.equal(a.customer_name, 'דנה');
  assert.equal(a.customer_phone, '+972501111111');
  assert.equal(a.total_price, 160);
  assert.equal((new Date(a.end_at) - new Date(a.start_at)) / 60000, 60);
  assert.deepEqual(a.items.map((i) => i.name), ['הסרת לק ג׳ל', 'לק ג׳ל אנטומי']);
});

test('קביעה: טיפול לפי יחידה מכפיל משך ומחיר', async () => {
  const a = await book(DANA, items(['השלמת ציפורן', 3]), '2027-01-04T10:00:00+02:00');
  assert.equal(a.total_price, 30);
  assert.equal((new Date(a.end_at) - new Date(a.start_at)) / 60000, 15);
  assert.equal(a.items[0].qty, 3);
});

test('קביעה: אי אפשר לקבוע על שעה תפוסה', async () => {
  await book(DANA, items('לק ג׳ל אנטומי'), '2027-01-04T10:00:00+02:00');
  await rejects(book(NOA, items('לק ג׳ל אנטומי'), '2027-01-04T10:00:00+02:00'), /SLOT_TAKEN/);
  await rejects(book(NOA, items('לק ג׳ל אנטומי'), '2027-01-04T10:30:00+02:00'), /SLOT_TAKEN/);
});

test('קביעה: שתי לקוחות באותו רגע על אותה שעה — רק אחת מצליחה', async () => {
  const start = '2027-01-04T10:00:00+02:00';
  const results = await Promise.allSettled([
    book(DANA, items('לק ג׳ל אנטומי'), start, NOW, db),
    book(NOA, items('לק ג׳ל אנטומי'), start, NOW, db2),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const failed = results.find((r) => r.status === 'rejected');
  assert.match(failed.reason.message, /SLOT_TAKEN/);
  assert.equal((await one(`select count(*)::int n from public.appointments where status = 'booked'`)).n, 1);
});

test('קביעה: האילוץ במסד עוצר כפל תורים גם אם עוקפים את הפונקציה', async () => {
  await book(DANA, items('לק ג׳ל אנטומי'), '2027-01-04T10:00:00+02:00');
  await assert.rejects(db.query(
    `insert into public.appointments (business_id, customer_name, items, total_price, start_at, end_at, created_by)
     values ($1, 'עוקפת', '[]', 0, '2027-01-04T10:20:00+02:00', '2027-01-04T11:00:00+02:00', 'owner')`, [biz]),
  (e) => e.code === '23P01');
});

test('קביעה: רק תור עתידי אחד ללקוחה', async () => {
  await book(DANA, items('לק ג׳ל אנטומי'), '2027-01-04T10:00:00+02:00');
  await rejects(book(DANA, items('לק ג׳ל אנטומי'), '2027-01-05T10:00:00+02:00'), /ALREADY_BOOKED/);
  // אחרי שהתור עבר אפשר לקבוע שוב
  const later = '2027-01-04T12:00:00+02:00';
  const a = await book(DANA, items('לק ג׳ל אנטומי'), '2027-01-05T10:00:00+02:00', later);
  assert.equal(a.status, 'booked');
});

test('קביעה: תור ידני שבעלת העסק קבעה לאותו טלפון נספר כתור העתידי של הלקוחה', async () => {
  await one('select * from private.owner_book($1, $2, $3, $4, $5, $6, null, $7)',
    [biz, OWNER, items('לק ג׳ל אנטומי'), '2027-01-06T10:00:00+02:00', 'דנה', '050-1111111', NOW]);
  await rejects(book(DANA, items('לק ג׳ל אנטומי'), '2027-01-05T10:00:00+02:00'), /ALREADY_BOOKED/);
});

test('קביעה: נדחית מחוץ לשעות העבודה, בזמן חסום, בתוך ההתראה המינימלית ומחוץ לחלון', async () => {
  const it = items('לק ג׳ל אנטומי');
  await rejects(book(DANA, it, '2027-01-04T20:00:00+02:00'), /SLOT_TAKEN/);           // אחרי שעות העבודה
  await rejects(book(DANA, it, '2027-01-04T18:30:00+02:00'), /SLOT_TAKEN/);           // גולש מעבר לסוף היום
  await rejects(book(DANA, it, '2027-01-04T10:10:00+02:00'), /SLOT_TAKEN/);           // לא על הקפיצה
  await rejects(book(DANA, it, '2027-01-09T10:00:00+02:00'), /SLOT_TAKEN/);           // שבת
  await rejects(book(DANA, it, '2027-01-03T09:00:00+02:00'), /SLOT_TAKEN/);           // בתוך שעתיים מעכשיו
  await rejects(book(DANA, it, '2027-03-01T10:00:00+02:00'), /SLOT_TAKEN/);           // מעבר ל-30 יום
  await db.query(
    `insert into public.time_off (business_id, start_at, end_at) values ($1, '2027-01-05T00:00+02', '2027-01-06T00:00+02')`, [biz]);
  await rejects(book(DANA, it, '2027-01-05T10:00:00+02:00'), /SLOT_TAKEN/);           // יום חסום
});

test('קביעה: טיפולים לא תקינים נדחים', async () => {
  const start = '2027-01-04T10:00:00+02:00';
  await rejects(book(DANA, '[]', start), /NO_SERVICES/);
  await rejects(book(DANA, JSON.stringify([{ service_id: '00000000-0000-4000-8000-00000000dead' }]), start), /INVALID_SERVICES/);
  await rejects(book(DANA, JSON.stringify([{ service_id: 'not-a-uuid' }]), start), /INVALID_SERVICES/);
  await rejects(book(DANA, items('לק ג׳ל אנטומי', 'לק ג׳ל אנטומי'), start), /INVALID_SERVICES/); // אותו טיפול פעמיים
  await db.query(`update public.services set active = false where name = 'בנייה בטיפס ג׳ל'`);
  await rejects(book(DANA, items('בנייה בטיפס ג׳ל'), start), /INVALID_SERVICES/);
});

test('קביעה: משתמשת בלי פרופיל או בלי שם נדחית', async () => {
  const it = items('לק ג׳ל אנטומי');
  await rejects(book('00000000-0000-4000-8000-00000000beef', it, '2027-01-04T10:00:00+02:00'), /NOT_LOGGED_IN/);
  await db.query(`update public.profiles set name = null where id = $1`, [NOA]);
  await rejects(book(NOA, it, '2027-01-04T10:00:00+02:00'), /NAME_REQUIRED/);
  await db.query(`update public.profiles set name = 'נועה' where id = $1`, [NOA]);
});

// ───────────────────────── ביטול ─────────────────────────

test('ביטול: לקוחה מבטלת עד סוף היום שלפני, והשעה מתפנה', async () => {
  const a = await book(DANA, items('לק ג׳ל אנטומי'), '2027-01-05T10:00:00+02:00');
  const lateEvening = '2027-01-04T23:59:00+02:00';
  const c = await one('select * from private.cancel($1, $2, $3)', [a.id, DANA, lateEvening]);
  assert.equal(c.status, 'cancelled');
  assert.equal(c.cancelled_by, 'customer');
  assert.ok((await slotsLocal(50, '2027-01-05')).includes('2027-01-05 10:00'));
  const again = await book(DANA, items('לק ג׳ל אנטומי'), '2027-01-06T10:00:00+02:00');
  assert.equal(again.status, 'booked');
});

test('ביטול: ביום התור עצמו הלקוחה לא יכולה לבטל', async () => {
  const a = await book(DANA, items('לק ג׳ל אנטומי'), '2027-01-05T10:00:00+02:00');
  await rejects(one('select * from private.cancel($1, $2, $3)', [a.id, DANA, '2027-01-05T00:01:00+02:00']), /CANCEL_TOO_LATE/);
  await rejects(one('select * from private.cancel($1, $2, $3)', [a.id, DANA, '2027-01-05T09:00:00+02:00']), /CANCEL_TOO_LATE/);
  assert.equal((await one('select status from public.appointments where id = $1', [a.id])).status, 'booked');
});

test('ביטול: לקוחה לא יכולה לבטל תור של מישהי אחרת; בעלת העסק יכולה תמיד', async () => {
  const a = await book(DANA, items('לק ג׳ל אנטומי'), '2027-01-05T10:00:00+02:00');
  await rejects(one('select * from private.cancel($1, $2, $3)', [a.id, NOA, NOW]), /NOT_FOUND/);
  const c = await one('select * from private.cancel($1, $2, $3)', [a.id, OWNER, '2027-01-05T09:30:00+02:00']);
  assert.equal(c.status, 'cancelled');
  assert.equal(c.cancelled_by, 'owner');
});

// ───────────────────────── תור ידני ─────────────────────────

test('תור ידני: מותר לחרוג משעות העבודה, אסור לחפוף', async () => {
  const ob = (start, name = 'רותי', phone = '', dur = null) => one(
    'select * from private.owner_book($1, $2, $3, $4, $5, $6, $7, $8)',
    [biz, OWNER, items('לק ג׳ל אנטומי'), start, name, phone, dur, NOW]);

  const late = await ob('2027-01-04T21:00:00+02:00');
  assert.equal(late.created_by, 'owner');
  assert.equal(late.customer_phone, null);
  const sat = await ob('2027-01-09T10:00:00+02:00', 'מרים', '0502222222', 90);
  assert.equal(sat.customer_phone, '+972502222222');
  assert.equal(sat.customer_id, NOA, 'משויך לפרופיל הקיים לפי הטלפון');
  assert.equal((new Date(sat.end_at) - new Date(sat.start_at)) / 60000, 90);

  await rejects(ob('2027-01-04T21:30:00+02:00'), /SLOT_TAKEN/);
  await rejects(ob('2027-01-05T10:00:00+02:00', 'רותי', '12345'), /INVALID_PHONE/);
  await rejects(ob('2027-01-05T10:00:00+02:00', '  '), /NAME_REQUIRED/);
  await rejects(one('select * from private.owner_book($1, $2, $3, $4, $5, $6, $7, $8)',
    [biz, DANA, items('לק ג׳ל אנטומי'), '2027-01-05T10:00:00+02:00', 'דנה', '', null, NOW]), /NOT_OWNER/);
});

// ───────────────────────── פרטיות והרשאות ─────────────────────────

test('פרטיות: לקוחה רואה רק את התורים והפרופיל שלה', async () => {
  await book(DANA, items('לק ג׳ל אנטומי'), '2027-01-04T10:00:00+02:00');
  await book(NOA, items('לק ג׳ל אנטומי'), '2027-01-04T12:00:00+02:00');

  const dana = await asUser(DANA, () => q('select customer_name from public.appointments'));
  assert.deepEqual(dana.map((r) => r.customer_name), ['דנה']);
  const profiles = await asUser(DANA, () => q('select name from public.profiles'));
  assert.deepEqual(profiles.map((r) => r.name), ['דנה']);

  const owner = await asUser(OWNER, () => q('select customer_name from public.appointments order by start_at'));
  assert.deepEqual(owner.map((r) => r.customer_name), ['דנה', 'נועה']);
});

test('פרטיות: פונקציית הזמינות מחזירה שעות בלבד', async () => {
  await book(NOA, items('לק ג׳ל אנטומי'), '2027-01-04T12:00:00+02:00');
  const res = await asUser(DANA, () => db.query(
    `select * from public.get_free_slots($1, $2, (now() at time zone 'Asia/Jerusalem')::date + 3, (now() at time zone 'Asia/Jerusalem')::date + 12)`,
    [biz, items('לק ג׳ל אנטומי')]));
  assert.deepEqual(res.fields.map((f) => f.name), ['slot_start']);
  assert.ok(res.rows.length > 0);
});

test('פרטיות: אורחת לא מחוברת לא רואה תורים, פרופילים או שעות, ולא יכולה לקבוע', async () => {
  await book(DANA, items('לק ג׳ל אנטומי'), '2027-01-04T10:00:00+02:00');
  const anon = (sql, params) => asRole('anon', null, () => q(sql, params));
  for (const table of ['appointments', 'profiles', 'working_hours', 'time_off', 'owners', 'otp_codes', 'notifications', 'push_subscriptions']) {
    await rejects(anon(`select * from public.${table}`), /permission denied/);
  }
  await rejects(anon('select * from public.get_free_slots($1, $2, $3, $3)', [biz, items('לק ג׳ל אנטומי'), '2027-01-10']), /permission denied/);
  await rejects(anon('select public.book_appointment($1, $2, $3)', [biz, items('לק ג׳ל אנטומי'), '2027-01-05T10:00:00+02:00']), /permission denied/);
  // המחירון ופרטי העסק כן גלויים
  assert.equal((await anon('select count(*)::int n from public.services'))[0].n, 6);
  assert.equal((await anon('select count(*)::int n from public.businesses'))[0].n, 1);
});

test('הרשאות: לקוחה לא יכולה לכתוב תורים ישירות, לשנות הגדרות או לגעת בטבלאות סגורות', async () => {
  const a = await book(DANA, items('לק ג׳ל אנטומי'), '2027-01-04T10:00:00+02:00');
  const dana = (sql, params) => asUser(DANA, () => q(sql, params));
  await rejects(dana(`insert into public.appointments (business_id, customer_name, items, total_price, start_at, end_at, created_by)
     values ($1, 'x', '[]', 0, now(), now() + interval '1 hour', 'customer')`, [biz]), /permission denied/);
  await rejects(dana(`update public.appointments set start_at = start_at + interval '1 day' where id = $1`, [a.id]), /permission denied/);
  await rejects(dana(`delete from public.appointments where id = $1`, [a.id]), /permission denied/);
  await rejects(dana(`update public.profiles set role = 'owner' where id = $1`, [DANA]), /permission denied/);
  await rejects(dana('select * from public.owners'), /permission denied/);
  await rejects(dana('select * from public.otp_codes'), /permission denied/);
  await rejects(dana('select * from public.notifications'), /permission denied/);
  await rejects(dana('select * from private.app_config'), /permission denied/);
  await rejects(dana('select public.app_config_get()'), /permission denied/);
  await rejects(dana(`select public.otp_verify($1, '+972500000000', '123456')`, [biz]), /permission denied/);
  await rejects(dana(`select public.profile_ensure($1, $2, '+972500000000')`, [DANA, biz]), /permission denied/);
  await rejects(dana(`select private.book($1, $2, $3, now(), now())`, [biz, NOA, items('לק ג׳ל אנטומי')]), /permission denied/);

  // שורות שהמדיניות מסתירה: העדכון "מצליח" אבל לא משנה כלום
  await dana(`update public.settings set buffer_min = 0 where business_id = $1`, [biz]);
  assert.equal((await one('select buffer_min from public.settings')).buffer_min, 10);
  await dana(`update public.services set price = 1`);
  assert.equal((await one(`select count(*)::int n from public.services where price = 1`)).n, 0);
  await rejects(dana(`insert into public.services (business_id, name, duration_min, price) values ($1, 'x', 10, 1)`, [biz]), /row-level security/);
  await rejects(dana(`insert into public.time_off (business_id, start_at, end_at) values ($1, now(), now() + interval '1 day')`, [biz]), /row-level security/);
  await rejects(dana(`select public.set_working_hours($1, '[]')`, [biz]), /NOT_OWNER/);
  await rejects(dana(`select public.push_test($1)`, [biz]), /NOT_OWNER/);
  await rejects(dana(`select public.owner_book_appointment($1, $2, now(), 'x')`, [biz, items('לק ג׳ל אנטומי')]), /NOT_OWNER/);
  assert.deepEqual(await dana('select * from public.working_hours'), []);
});

test('הרשאות: בעלת העסק עורכת הגדרות, מחירון, שעות וחסימות', async () => {
  const owner = (sql, params) => asUser(OWNER, () => q(sql, params));
  await owner(`update public.settings set buffer_min = 15, address = 'הרצל 1' where business_id = $1`, [biz]);
  assert.equal((await one('select buffer_min from public.settings')).buffer_min, 15);
  await owner(`update public.businesses set name = 'הסטודיו של מיכל' where id = $1`, [biz]);
  await owner(`update public.services set price = 140 where name = 'לק ג׳ל אנטומי'`);
  assert.equal((await one(`select price from public.services where name = 'לק ג׳ל אנטומי'`)).price, 140);
  await owner(`insert into public.time_off (business_id, start_at, end_at, reason) values ($1, now(), now() + interval '1 day', 'חופש')`, [biz]);
  await owner(`select public.set_working_hours($1, $2)`, [biz, JSON.stringify([
    { weekday: 0, start_time: '10:00', end_time: '14:00' }, { weekday: 0, start_time: '16:00', end_time: '20:00' }])]);
  assert.equal((await one('select count(*)::int n from public.working_hours')).n, 2);
  await rejects(owner(`select public.set_working_hours($1, $2)`, [biz, JSON.stringify([{ weekday: 0, start_time: '18:00', end_time: '10:00' }])]), /INVALID_HOURS/);
  assert.equal((await one('select count(*)::int n from public.working_hours')).n, 2, 'שמירה שנכשלה לא מוחקת את הקיים');
  await db.query(`update public.services set price = 130 where name = 'לק ג׳ל אנטומי'`);
  await db.query(`update public.businesses set name = 'סטודיו לק ג׳ל'`);
  await db.query(`update public.settings set address = ''`);
});

test('הרשאות: דרך ה-API לקוחה קובעת ומבטלת רק לעצמה', async () => {
  const start = (await asUser(DANA, () => one(
    `select slot_start from public.get_free_slots($1, $2, (now() at time zone 'Asia/Jerusalem')::date + 3, (now() at time zone 'Asia/Jerusalem')::date + 12) limit 1`,
    [biz, items('לק ג׳ל אנטומי')]))).slot_start;
  const a = await asUser(DANA, () => one('select * from public.book_appointment($1, $2, $3)', [biz, items('לק ג׳ל אנטומי'), start]));
  assert.equal(a.customer_id, DANA);
  await rejects(asUser(NOA, () => q('select * from public.cancel_appointment($1)', [a.id])), /NOT_FOUND/);
  const c = await asUser(DANA, () => one('select * from public.cancel_appointment($1)', [a.id]));
  assert.equal(c.status, 'cancelled');
  const named = await asUser(DANA, () => one(`select * from public.set_my_name('  דנה כהן  ')`));
  assert.equal(named.name, 'דנה כהן');
  await db.query(`update public.profiles set name = 'דנה' where id = $1`, [DANA]);
});

// ───────────────────────── כניסה בקוד ─────────────────────────

test('קוד כניסה: קוד נכון עובד פעם אחת, קוד שגוי ננעל אחרי 5 ניסיונות', async () => {
  const phone = '+972503333333';
  assert.equal((await one('select public.otp_request($1, $2, $3) r', [biz, phone, '123456'])).r, 'ok');
  assert.equal((await one('select code_hash from public.otp_codes')).code_hash.length, 64, 'נשמר גיבוב, לא הקוד');
  assert.equal((await one('select public.otp_verify($1, $2, $3) r', [biz, phone, '000000'])).r, false);
  assert.equal((await one('select public.otp_verify($1, $2, $3) r', [biz, phone, '123456'])).r, true);
  assert.equal((await one('select public.otp_verify($1, $2, $3) r', [biz, phone, '123456'])).r, false, 'קוד חד-פעמי');

  await db.query('truncate public.otp_codes');
  await q('select public.otp_request($1, $2, $3)', [biz, phone, '654321']);
  for (let i = 0; i < 5; i++) await q('select public.otp_verify($1, $2, $3)', [biz, phone, '111111']);
  assert.equal((await one('select public.otp_verify($1, $2, $3) r', [biz, phone, '654321'])).r, false, 'ננעל');
});

test('קוד כניסה: פג תוקף אחרי 10 דקות, ומוגבל ל-3 בקשות ברבע שעה', async () => {
  const phone = '+972503333333';
  await q('select public.otp_request($1, $2, $3)', [biz, phone, '123456']);
  await db.query(`update public.otp_codes set expires_at = now() - interval '1 second'`);
  assert.equal((await one('select public.otp_verify($1, $2, $3) r', [biz, phone, '123456'])).r, false);
  await q('select public.otp_request($1, $2, $3)', [biz, phone, '222222']);
  assert.equal((await one('select public.otp_request($1, $2, $3) r', [biz, phone, '333333'])).r, 'ok');
  assert.equal((await one('select public.otp_request($1, $2, $3) r', [biz, phone, '444444'])).r, 'rate_limited');
  assert.equal((await one('select public.otp_request($1, $2, $3) r', [biz, '+972504444444', '444444'])).r, 'ok', 'מספר אחר לא מושפע');
});

test('כניסה: פרופיל חדש מקבל תפקיד לפי הטלפון, ותורים ידניים משויכים אליו', async () => {
  const uid = '00000000-0000-4000-8000-000000000009';
  await db.query('insert into auth.users (id) values ($1)', [uid]);
  await one('select * from private.owner_book($1, $2, $3, $4, $5, $6, null, $7)',
    [biz, OWNER, items('לק ג׳ל אנטומי'), '2027-01-06T10:00:00+02:00', 'שירה', '0505555555', NOW]);
  const p = await one('select * from public.profile_ensure($1, $2, $3)', [uid, biz, '+972505555555']);
  assert.equal(p.role, 'customer');
  assert.equal(p.name, null);
  assert.equal((await one('select customer_id from public.appointments')).customer_id, uid);
  await db.query('delete from auth.users where id = $1', [uid]);

  const again = await one('select * from public.profile_ensure($1, $2, $3)', [OWNER, biz, '+972500000000']);
  assert.equal(again.role, 'owner');
  assert.equal(again.name, 'בעלת העסק', 'כניסה חוזרת לא מוחקת את השם');
});

// ───────────────────────── הודעות ותזכורות ─────────────────────────

test('הודעות: קביעה וביטול של לקוחה מייצרים הודעות; פעולות של בעלת העסק לא מתריעות לה', async () => {
  const kinds = async () => (await q('select kind from public.notifications order by id')).map((r) => r.kind);
  const start = (await one(
    `select slot_start from private.free_slots($1, 50, (now() at time zone 'Asia/Jerusalem')::date + 3, (now() at time zone 'Asia/Jerusalem')::date + 12, now()) limit 1`, [biz])).slot_start;
  const a = await book(DANA, items('לק ג׳ל אנטומי'), start, new Date().toISOString());
  assert.deepEqual(await kinds(), ['customer_confirm', 'owner_booked']);
  await one('select * from private.cancel($1, $2, now())', [a.id, DANA]);
  assert.deepEqual(await kinds(), ['customer_confirm', 'owner_booked', 'owner_cancelled']);

  await db.query('truncate public.notifications');
  const b = await one('select * from private.owner_book($1, $2, $3, $4, $5, $6, null, now())',
    [biz, OWNER, items('לק ג׳ל אנטומי'), start, 'רותי', '0506666666']);
  assert.deepEqual(await kinds(), ['customer_confirm'], 'הלקוחה מקבלת אישור, בעלת העסק לא מקבלת פוש על עצמה');
  await one('select * from private.cancel($1, $2, now())', [b.id, OWNER]);
  assert.deepEqual(await kinds(), ['customer_confirm']);
});

test('תזכורות: נשלחות פעם אחת, ביום שלפני, מרגע ששעת התזכורת הגיעה', async () => {
  const a = await book(DANA, items('לק ג׳ל אנטומי'), '2027-01-05T10:00:00+02:00'); // נקבע ביום ראשון 08:00 ליום שלישי
  await db.query('truncate public.notifications');
  const run = async (now) => (await one('select private.reminders_enqueue($1) n', [now])).n;

  assert.equal(await run('2027-01-03T12:00:00+02:00'), 0, 'יומיים לפני: עוד לא');
  assert.equal(await run('2027-01-04T09:55:00+02:00'), 0, 'יום לפני, לפני 10:00: עוד לא');
  assert.equal(await run('2027-01-04T10:00:00+02:00'), 1, 'יום לפני ב-10:00: נשלחת');
  assert.equal(await run('2027-01-04T10:05:00+02:00'), 0, 'לא נשלחת פעמיים');
  assert.deepEqual((await q('select kind, appointment_id from public.notifications')),
    [{ kind: 'customer_reminder', appointment_id: a.id }]);
});

test('תזכורות: לא לתור מבוטל, לא לתור בלי טלפון, ולא לתור שנקבע אחרי שעת התזכורת', async () => {
  const run = async (now) => (await one('select private.reminders_enqueue($1) n', [now])).n;
  const a = await book(DANA, items('לק ג׳ל אנטומי'), '2027-01-05T10:00:00+02:00');
  await one('select * from private.cancel($1, $2, $3)', [a.id, DANA, NOW]);
  await one('select * from private.owner_book($1, $2, $3, $4, $5, $6, null, $7)',
    [biz, OWNER, items('לק ג׳ל אנטומי'), '2027-01-05T12:00:00+02:00', 'בלי טלפון', '', NOW]);
  // נועה קובעת ביום שני ב-15:00 למחר — אחרי שעת התזכורת
  await book(NOA, items('לק ג׳ל אנטומי'), '2027-01-05T14:00:00+02:00', '2027-01-04T15:00:00+02:00');
  assert.equal(await run('2027-01-04T16:00:00+02:00'), 0);
});

test('תזכורות: אם התזמון היה למטה, התזכורת עדיין יוצאת מאוחר יותר באותו יום', async () => {
  await book(DANA, items('לק ג׳ל אנטומי'), '2027-01-05T10:00:00+02:00');
  assert.equal((await one('select private.reminders_enqueue($1) n', ['2027-01-04T17:30:00+02:00'])).n, 1);
});

test('הודעות: המשיכה מהתור מחזירה טקסט מוכן בעברית ומסמנת "בשליחה"', async () => {
  const start = (await one(
    `select slot_start from private.free_slots($1, 60, (now() at time zone 'Asia/Jerusalem')::date + 3, (now() at time zone 'Asia/Jerusalem')::date + 12, now()) limit 1`, [biz])).slot_start;
  await book(DANA, items('הסרת לק ג׳ל', 'לק ג׳ל אנטומי'), start, new Date().toISOString());
  const jobs = (await one('select public.notifications_claim(10) j')).j;
  assert.equal(jobs.length, 2);
  const [confirm] = jobs;
  assert.equal(confirm.kind, 'customer_confirm');
  assert.equal(confirm.customer_name, 'דנה');
  assert.equal(confirm.customer_phone, '+972501111111');
  assert.equal(confirm.services_text, 'הסרת לק ג׳ל, לק ג׳ל אנטומי');
  assert.match(confirm.day_text, /^יום (ראשון|שני|שלישי|רביעי|חמישי|שישי)$/);
  assert.match(confirm.time_text, /^\d\d:\d\d$/);
  assert.equal((await one('select public.notifications_claim(10) j')).j.length, 0, 'לא נמשכת פעמיים');

  await q(`select public.notification_done($1, 'sent')`, [jobs[0].id]);
  await q(`select public.notification_done($1, 'failed', 'boom')`, [jobs[1].id]);
  const rows = await q('select status, error from public.notifications order by id');
  assert.deepEqual(rows, [{ status: 'sent', error: null }, { status: 'failed', error: 'boom' }]);
  // הודעה שנכשלה חוזרת לתור אחרי כמה דקות
  await db.query(`update public.notifications set claimed_at = now() - interval '5 minutes' where status = 'failed'`);
  assert.equal((await one('select public.notifications_claim(10) j')).j.length, 1);
});

test('טלפון: נרמול מספרים ישראליים', async () => {
  const n = async (p) => (await one('select private.phone_normalize($1) r', [p])).r;
  assert.equal(await n('050-123 4567'), '+972501234567');
  assert.equal(await n('+972 50-1234567'), '+972501234567');
  assert.equal(await n('972501234567'), '+972501234567');
  assert.equal(await n('501234567'), '+972501234567');
  assert.equal(await n('03-1234567'), null);
  assert.equal(await n('0501234'), null);
  assert.equal(await n(''), null);
});

// ───────────────────────── שער השרת ─────────────────────────

const SECRET = 'test-secret-0123456789abcdef0123456789';

const asAnon = (fn) => asRole('anon', null, fn);

test('שער השרת: בלי הסוד הנכון אי אפשר לקרוא לשום פונקציית שרת', async () => {
  await db.query(`insert into private.app_config (key, value) values ('dispatch_secret', $1)
                  on conflict (key) do update set value = excluded.value`, [SECRET]);
  for (const bad of ['', 'wrong', SECRET + 'x']) {
    await rejects(asAnon(() => db.query(`select public.srv_login_start($1, 'main', '0501234567', '1234')`, [bad])), /FORBIDDEN/);
    await rejects(asAnon(() => db.query('select public.srv_notifications_claim($1, 5)', [bad])), /FORBIDDEN/);
    await rejects(asAnon(() => db.query('select public.srv_config($1)', [bad])), /FORBIDDEN/);
  }
  // סוד קצר מדי לא מתקבל גם אם הוא שמור
  await db.query(`update private.app_config set value = 'short' where key = 'dispatch_secret'`);
  await rejects(asAnon(() => db.query(`select public.srv_config('short')`)), /FORBIDDEN/);
  await db.query(`update private.app_config set value = $1 where key = 'dispatch_secret'`, [SECRET]);
});

test('שער השרת: כניסה מלאה — קוד, משתמשת חדשה, כניסה חוזרת עם סיסמה חדשה', async () => {
  const start = (await asAnon(() => one(`select public.srv_login_start($1, 'main', '050-777 7777', '4321') r`, [SECRET]))).r;
  assert.deepEqual(start, { status: 'ok', phone: '+972507777777' });

  const wrong = (await asAnon(() => one(`select public.srv_login_finish($1, 'main', '0507777777', '0000') r`, [SECRET]))).r;
  assert.deepEqual(wrong, { ok: false });

  const first = (await asAnon(() => one(`select public.srv_login_finish($1, 'main', '0507777777', '4321') r`, [SECRET]))).r;
  assert.equal(first.ok, true);
  assert.equal(first.email, 'p972507777777@users.gel-nail-polish.app');
  assert.equal(first.role, 'customer');
  assert.equal(first.has_name, false);
  assert.match(first.password, /^[0-9a-f]{48}$/);
  const user = await one('select id, encrypted_password from auth.users where email = $1', [first.email]);
  assert.ok(user.encrypted_password.startsWith('$2'), 'נשמר גיבוב bcrypt');
  assert.equal((await one('select count(*)::int n from auth.identities where user_id = $1', [user.id])).n, 1);
  assert.equal((await one('select phone from public.profiles where id = $1', [user.id])).phone, '+972507777777');

  // כניסה חוזרת: אותה משתמשת, סיסמה אחרת
  await asAnon(() => one(`select public.srv_login_start($1, 'main', '0507777777', '9999')`, [SECRET]));
  const second = (await asAnon(() => one(`select public.srv_login_finish($1, 'main', '0507777777', '9999') r`, [SECRET]))).r;
  assert.equal(second.ok, true);
  assert.notEqual(second.password, first.password);
  assert.equal((await one('select count(*)::int n from auth.users where email = $1', [first.email])).n, 1);
  assert.equal((await one('select count(*)::int n from auth.identities where user_id = $1', [user.id])).n, 1);

  await db.query('delete from public.profiles where id = $1', [user.id]);
  await db.query('delete from auth.identities where user_id = $1', [user.id]);
  await db.query('delete from auth.users where id = $1', [user.id]);
});

test('שער השרת: מספר לא תקין ועסק לא קיים', async () => {
  assert.deepEqual((await asAnon(() => one(`select public.srv_login_start($1, 'main', '03-1234567', '1234') r`, [SECRET]))).r,
    { status: 'invalid_phone' });
  assert.deepEqual((await asAnon(() => one(`select public.srv_login_start($1, 'nope', '0501234567', '1234') r`, [SECRET]))).r,
    { status: 'no_business' });
});

test('שער השרת: הודעות ומנויי פוש של בעלת העסק', async () => {
  await db.query(`insert into public.push_subscriptions (business_id, profile_id, endpoint, p256dh, auth)
                  values ($1, $2, 'https://push.example/owner', 'k', 'a'), ($1, $3, 'https://push.example/dana', 'k', 'a')`,
    [biz, OWNER, DANA]);
  const targets = (await asAnon(() => one('select public.srv_owner_push_targets($1, $2) r', [SECRET, biz]))).r;
  assert.deepEqual(targets.map((t) => t.endpoint), ['https://push.example/owner'], 'רק מנויים של בעלת העסק');
  await asAnon(() => q('select public.srv_push_remove($1, $2)', [SECRET, 'https://push.example/owner']));
  assert.equal((await one('select count(*)::int n from public.push_subscriptions')).n, 1);
  await db.query('delete from public.push_subscriptions');

  await db.query(`insert into public.notifications (business_id, kind) values ($1, 'owner_test')`, [biz]);
  const jobs = (await asAnon(() => one('select public.srv_notifications_claim($1, 10) r', [SECRET]))).r;
  assert.equal(jobs.length, 1);
  await asAnon(() => q(`select public.srv_notification_done($1, $2, 'sent')`, [SECRET, jobs[0].id]));
  assert.equal((await one('select status from public.notifications')).status, 'sent');
});

test('רישום בעלת העסק: קוד הקמה נכון הופך לקוחה לבעלת העסק, פעם אחת בלבד', async () => {
  await db.query(`insert into private.app_config (key, value) values ('owner_claim_code', 'CLAIM-12345')
                  on conflict (key) do update set value = excluded.value`);
  await rejects(asUser(NOA, () => db.query('select public.claim_owner($1, $2)', [biz, 'wrong'])), /BAD_CLAIM_CODE/);
  const p = await asUser(NOA, () => one('select * from public.claim_owner($1, $2)', [biz, 'CLAIM-12345']));
  assert.equal(p.role, 'owner');
  assert.ok(await one(`select 1 from public.owners where phone = '+972502222222'`));
  await rejects(asUser(DANA, () => db.query('select public.claim_owner($1, $2)', [biz, 'CLAIM-12345'])), /BAD_CLAIM_CODE/, 'חד-פעמי');
  await rejects(asAnon(() => db.query('select public.claim_owner($1, $2)', [biz, 'x'])), /permission denied/);

  await db.query(`update public.profiles set role = 'customer' where id = $1`, [NOA]);
  await db.query(`delete from public.owners where phone = '+972502222222'`);
});

test('פרטיות: אורחת לא יכולה לקרוא להגדרות השרת דרך הפונקציות הפנימיות', async () => {
  for (const sql of ['select public.app_config_get()', 'select public.notifications_claim(1)',
                     `select public.otp_request('00000000-0000-4000-8000-000000000000', '+972501111111', '1234')`]) {
    await rejects(asAnon(() => db.query(sql)), /permission denied/);
  }
  assert.equal((await asAnon(() => one('select public.push_public_key() k'))).k, null);
});
