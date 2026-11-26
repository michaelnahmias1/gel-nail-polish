// מסכי בעלת העסק: יומן שבועי, פרטי תור, תור ידני, הגדרות, ורישום ראשוני כבעלת העסק.
import {
  h, mount, header, spinner, toast, showError, errorText, busy, fieldError, clearFieldError, setLeaveGuard,
  dateKey, timeText, shortDate, longDate, dayLabel, dayName, todayKey, addDays, weekdayOf, zonedToDate,
  money, minutesText, itemsText, waLink, phoneDisplay,
} from './ui.js';
import { icon } from './icons.js';
import { state, loadProfile, loadBusiness, logout, go } from './app.js';

const minutesBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);

// טקסט משמאל לימין בתוך שורה עברית (טווחי שעות, תאריכים, טלפונים, קישורים),
// כדי ש-09:00–18:00 לא יוצג הפוך.
const ltr = (text) => h('span.ltr', { dir: 'ltr' }, text);
// אותו דבר לטקסט רגיל (חלונות confirm): בידוד LRI…PDI.
const ltrPlain = (text) => `⁦${text}⁩`;
const range = (a, b) => `${a}–${b}`;

// «תור אחד» / «3 תורים».
const countText = (n, one, many) => (n === 1 ? one : `${n} ${many}`);

const hhmmToMin = (t) => { const [hh, mm] = t.split(':').map(Number); return hh * 60 + mm; };
const minToHhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// «יום שלישי, 1 בדצמבר» (עם «היום»/«מחר» כשמתאים).
function dayAndDate(ts) {
  const k = dateKey(ts);
  const label = dayLabel(k);
  const day = label.startsWith('יום') ? label : `${label}, יום ${dayName(weekdayOf(k))}`;
  return `${day}, ${longDate(ts)}`;
}

// נייד ישראלי — אותו כלל כמו private.phone_normalize במסד.
const isMobile = (v) => /^(9725\d{8}|05\d{8}|5\d{8})$/.test(String(v).replace(/\D/g, ''));
// טלפון ליצירת קשר: נייד או קווי.
const isPhone = (v) => /^(0\d{8,9}|972\d{8,9})$/.test(String(v).replace(/\D/g, ''));

// ───────────────────────── רישום כבעלת העסק ─────────────────────────

export function claim() {
  const input = h('input.field', { id: 'claim', autocomplete: 'off', dir: 'ltr', required: true, autocapitalize: 'off', spellcheck: 'false' });
  const btn = h('button.btn.primary', { type: 'submit' }, 'אישור');
  const submit = busy(btn, async () => {
    const code = input.value.trim();
    if (!code) return fieldError(input, 'צריך להזין את קוד ההקמה');
    const { error } = await state.sb.rpc('claim_owner', { p_business: state.business.id, p_code: code });
    if (error) {
      if (/BAD_CLAIM_CODE/.test(error.message || '')) return fieldError(input, errorText(error));
      return showError(error);
    }
    await loadProfile();
    toast('את רשומה כבעלת העסק');
    go('#/owner', { replace: true });
  });
  mount(h('main.page',
    header('הקמת בעלת העסק', { back: '#/' }),
    h('div.card', h('form.stack', { onsubmit: (e) => { e.preventDefault(); submit(); }, novalidate: true },
      h('p', 'הזיני את קוד ההקמה שקיבלת. המספר שאיתו התחברת יירשם כמספר של בעלת העסק.'),
      h('div.stack.tight', h('label.label', { for: 'claim' }, 'קוד הקמה'), input),
      btn))));
}

// ───────────────────────── יומן שבועי ─────────────────────────

let calendarParams = null; // הפרמטרים של היומן שמוצג כרגע (לרענון)
let calendarToken = 0;     // רק הטעינה האחרונה מציירת

// האם הכתובת עדיין של היומן (#/ או #/owner)? כדי לא לצייר יומן מעל מסך שכבר עברו אליו.
const onCalendarRoute = () => ['/', '/owner'].includes((location.hash.replace(/^#/, '') || '/').split('?')[0]);

export function calendar(params = {}) {
  calendarParams = params;
  return renderCalendar(params, { silent: false });
}

// רענון בשקט כשחוזרים לאפליקציה (למשל אחרי שלקוחה קבעה תור בזמן שהטלפון היה נעול).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!document.querySelector('main[data-view="calendar"]')) return;
  renderCalendar(calendarParams || {}, { silent: true }).catch(showError);
});

// מחזירה true אם היומן צויר.
async function renderCalendar(params, { silent }) {
  // רענון שקט רק כשהיומן כבר מוצג — לא באמצע טעינה ראשונה.
  if (silent && !document.querySelector('main[data-view="calendar"]')) return false;
  const token = ++calendarToken;
  const focus = params.d && /^\d{4}-\d{2}-\d{2}$/.test(params.d) ? params.d : todayKey();
  const weekStart = addDays(focus, -weekdayOf(focus));
  const weekEnd = addDays(weekStart, 7);
  const fromTs = zonedToDate(weekStart, '00:00').toISOString();
  const toTs = zonedToDate(weekEnd, '00:00').toISOString();

  if (!silent) mount(h('main.page', ownerTop(), h('div.center', spinner())));

  const [appts, offs, hours] = await Promise.all([
    state.sb.from('appointments').select('*').eq('business_id', state.business.id).eq('status', 'booked')
      .gte('start_at', fromTs).lt('start_at', toTs).order('start_at'),
    state.sb.from('time_off').select('*').eq('business_id', state.business.id)
      .lt('start_at', toTs).gt('end_at', fromTs).order('start_at'),
    state.sb.from('working_hours').select('*').eq('business_id', state.business.id).order('start_time'),
  ]);
  for (const r of [appts, offs, hours]) if (r.error) throw r.error;
  // בזמן הטעינה עברו למסך אחר או לשבוע אחר — לא דורסים.
  if (token !== calendarToken || !onCalendarRoute()) return false;
  if (silent && !document.querySelector('main[data-view="calendar"]')) return false;

  const total = appts.data.length;
  const nav = h('div.week-nav',
    h('button.btn.ghost', { type: 'button', onclick: () => go(`#/owner?d=${addDays(weekStart, -7)}`) }, '→ שבוע קודם'),
    h('button.link', { type: 'button', onclick: () => go('#/owner') }, 'היום'),
    h('button.btn.ghost', { type: 'button', onclick: () => go(`#/owner?d=${addDays(weekStart, 7)}`) }, 'שבוע הבא ←'));

  const days = [];
  for (let i = 0; i < 7; i++) {
    const k = addDays(weekStart, i);
    const dayAppts = appts.data.filter((a) => dateKey(a.start_at) === k);
    const dayOffs = offs.data.filter((o) => dateKey(o.start_at) <= k && dateKey(new Date(new Date(o.end_at) - 1)) >= k);
    const dayHours = hours.data.filter((w) => w.weekday === weekdayOf(k));
    const past = k < todayKey();
    const items = [
      ...dayAppts.map((a) => ({ at: a.start_at, el: apptRow(a) })),
      ...dayOffs.map((o) => ({ at: o.start_at, el: offRow(o, k) })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at));

    days.push(h('section.day-block', { id: `d-${k}`, class: (k === todayKey() ? 'today' : '') + (past ? ' past' : '') },
      h('div.day-head',
        h('h3', `${dayLabel(k) === 'היום' ? 'היום · ' : ''}יום ${dayName(weekdayOf(k))}`, ' ', h('span.muted', ltr(shortDate(`${k}T12:00:00Z`)))),
        h('span.muted', dayHours.length
          ? dayHours.flatMap((w, j) => [j ? ', ' : null, ltr(range(w.start_time.slice(0, 5), w.end_time.slice(0, 5)))])
          : 'סגור')),
      items.length ? items.map((x) => x.el) : h('p.muted.small', past ? '' : 'אין תורים'),
      past ? null : h('a.add-here', { href: `#/owner/new?d=${k}` }, icon('plus'), ' תור ידני')));
  }

  const y = window.scrollY;
  mount(h('main.page.owner', { 'data-view': 'calendar' },
    ownerTop(),
    pushBanner(),
    nav,
    h('p.muted.center-text', `${longDate(`${weekStart}T12:00:00Z`)} – ${longDate(`${addDays(weekStart, 6)}T12:00:00Z`)} · ${total ? countText(total, 'תור אחד', 'תורים') : 'אין תורים'}`),
    days,
    h('a.fab', { href: `#/owner/new?d=${focus < todayKey() ? todayKey() : focus}`, 'aria-label': 'תור ידני' }, icon('plus'))));
  if (silent) window.scrollTo(0, y);
  else document.getElementById(`d-${focus}`)?.scrollIntoView({ block: 'start' });
  return true;
}

function offRow(o, k) {
  const fromStart = dateKey(o.start_at) !== k;          // התחילה ביום קודם
  const toEnd = dateKey(o.end_at) !== k;                // נמשכת עד חצות או אחריו
  const when = (fromStart || timeText(o.start_at) === '00:00') && toEnd ? 'כל היום'
    : ltr(range(fromStart ? '00:00' : timeText(o.start_at), toEnd ? '24:00' : timeText(o.end_at)));
  return h('div.off-row', icon('block'), ' חסום',
    o.reason ? ` · ${o.reason}` : '',
    ' ', h('span.muted', when));
}

function ownerTop() {
  const refresh = h('button.icon-btn', { type: 'button', 'aria-label': 'רענון היומן' }, icon('refresh'));
  refresh.onclick = busy(refresh, async () => {
    try {
      if (await renderCalendar(calendarParams || {}, { silent: true })) toast('היומן עודכן');
    } catch (e) { showError(e); }
  });
  return h('header.top.owner-top',
    h('a.icon-btn', { href: '#/owner/settings', 'aria-label': 'הגדרות' }, icon('settings')),
    h('h1', state.business.name),
    refresh);
}

function apptRow(a) {
  return h('a.appt-row', { href: `#/owner/appt/${a.id}` },
    h('span.appt-time', timeText(a.start_at), h('small', timeText(a.end_at))),
    h('span.appt-main', h('strong', a.customer_name), h('span.muted', itemsText(a.items))),
    h('span.appt-side', h('span.muted', money(a.total_price)), a.created_by === 'owner' ? h('small.tag', 'ידני') : null));
}

// ───────────────────────── פרטי תור ─────────────────────────

export async function appointment(_params, id) {
  mount(h('main.page', header('פרטי תור'), h('div.center', spinner())));
  const { data: a, error } = await state.sb.from('appointments').select('*').eq('id', id).single();
  if (error) throw error;
  const back = `#/owner?d=${dateKey(a.start_at)}`;
  const kv = (k, v) => h('div.kv', h('span.k', k), h('span.v', v));
  const when = dayAndDate(a.start_at);
  const time = timeText(a.start_at);

  const render = (justCancelled = false) => {
    const cancelBtn = h('button.btn.danger', { type: 'button' }, 'ביטול התור');
    cancelBtn.onclick = busy(cancelBtn, async () => {
      const ok = window.confirm(`לבטל את התור של ${a.customer_name}?\n\n${when}, בשעה ${ltrPlain(time)}.\n\nהלקוחה לא תקבל הודעה אוטומטית על הביטול.`);
      if (!ok) return;
      const { error: e } = await state.sb.rpc('cancel_appointment', { p_id: a.id });
      if (e) return showError(e);
      a.status = 'cancelled';
      toast('התור בוטל');
      render(true);
    });

    // אחרי ביטול על ידי בעלת העסק המערכת לא שולחת כלום — מציעים הודעה מוכנה.
    const waText = `היי ${a.customer_name}, כאן ${state.business.name}. התור שלך ביום ${dayName(weekdayOf(dateKey(a.start_at)))}, ${longDate(a.start_at)} בשעה ${time} בוטל. אפשר לקבוע תור חדש כאן: ${location.origin}/`;
    const cancelledCard = justCancelled ? h('div.card.warn.stack', { role: 'status' },
      h('strong', 'התור בוטל. הלקוחה לא קיבלה על כך הודעה.'),
      a.customer_phone
        ? h('a.btn.primary', { href: waLink(a.customer_phone, waText), target: '_blank', rel: 'noopener' }, icon('whatsapp'), ' כתבי לה בוואטסאפ')
        : h('p', 'אין טלפון שמור לתור הזה — כדאי לעדכן אותה בדרך אחרת.'),
      h('button.btn.secondary', { type: 'button', onclick: () => go(back) }, 'חזרה ליומן')) : null;

    mount(h('main.page',
      header('פרטי תור', { back }),
      cancelledCard,
      h('div.card.stack',
        h('h2', a.customer_name),
        kv('מתי', when),
        kv('שעה', h('span', ltr(range(time, timeText(a.end_at))), ` (${minutesText(minutesBetween(a.start_at, a.end_at))})`)),
        kv('טיפול', itemsText(a.items)),
        kv('מחיר', money(a.total_price)),
        kv('נקבע', a.created_by === 'customer' ? 'על ידי הלקוחה' : 'ידנית'),
        a.status === 'cancelled' ? kv('מצב', 'בוטל') : null,
        a.customer_phone ? kv('טלפון', ltr(phoneDisplay(a.customer_phone))) : null),
      a.customer_phone && !justCancelled ? h('div.row',
        h('a.btn.secondary', { href: `tel:${a.customer_phone}` }, icon('phone'), ' התקשרות'),
        h('a.btn.secondary', { href: waLink(a.customer_phone), target: '_blank', rel: 'noopener' }, icon('whatsapp'), ' וואטסאפ')) : null,
      a.status === 'booked' && new Date(a.end_at) > new Date() ? cancelBtn : null));
  };
  render();
}

// ───────────────────────── תור ידני ─────────────────────────

// השעה העגולה הקרובה בשעון ישראל (14:20 → 15:00). אחרי 23:00 — אין.
function nextRoundHour() {
  const m = hhmmToMin(timeText(Date.now()));
  const next = Math.ceil(m / 60) * 60;
  return next < 24 * 60 ? minToHhmm(next) : '';
}

export function manualBooking(params) {
  const chosen = new Map(); // service_id → qty
  const services = state.services.filter((s) => s.active);
  const totals = h('p.muted', { 'aria-live': 'polite' });
  const servicesError = h('p.field-error', { id: 'services-error', role: 'alert', hidden: true });
  const durInput = h('input.field', { type: 'number', min: 5, max: 600, step: 5, inputmode: 'numeric', id: 'dur' });

  const recompute = () => {
    let d = 0;
    let p = 0;
    for (const [id, qty] of chosen) {
      const s = state.services.find((x) => x.id === id);
      d += s.duration_min * qty;
      p += s.price * qty;
    }
    durInput.placeholder = d ? String(d) : 'דקות';
    totals.textContent = chosen.size ? `${minutesText(Number(durInput.value) || d)} · ${money(p)}` : 'בחרי טיפול';
    if (chosen.size) servicesError.hidden = true;
  };
  durInput.addEventListener('input', recompute);

  const serviceList = services.map((s) => {
    const qtyInput = s.price_type === 'per_unit'
      ? h('input.field.qty-input', { type: 'number', min: 1, max: 20, value: 1, 'aria-label': `כמות — ${s.name}`, inputmode: 'numeric' })
      : null;
    const box = h('input', { type: 'checkbox', id: `s-${s.id}`, 'aria-describedby': 'services-error' });
    const sync = () => {
      if (box.checked) chosen.set(s.id, s.price_type === 'per_unit' ? Math.min(20, Math.max(1, Math.round(Number(qtyInput.value)) || 1)) : 1);
      else chosen.delete(s.id);
      recompute();
    };
    box.addEventListener('change', sync);
    // הקלדת כמות = בחירה בטיפול.
    qtyInput?.addEventListener('input', () => { if (qtyInput.value !== '') box.checked = true; sync(); });
    return h('label.check-row', { for: `s-${s.id}` }, box,
      h('span.grow', s.name, h('span.muted', ` · ${minutesText(s.duration_min)} · ${money(s.price)}${s.price_type === 'per_unit' ? ' ליחידה' : ''}`)),
      qtyInput);
  });

  const initialDate = params.d && params.d >= todayKey() ? params.d : todayKey();
  const date = h('input.field', { type: 'date', id: 'date', value: initialDate, min: todayKey(), required: true });
  const defaultTime = (d) => (d === todayKey() ? nextRoundHour() : '');
  const time = h('input.field', { type: 'time', id: 'time', step: 300, value: defaultTime(initialDate), required: true });
  let timeTouched = false;
  time.addEventListener('input', () => { timeTouched = true; });
  date.addEventListener('change', () => { if (!timeTouched) time.value = defaultTime(date.value); });
  const name = h('input.field', { id: 'cname', maxlength: 60, autocomplete: 'off', required: true });
  const phone = h('input.field', {
    id: 'cphone', type: 'tel', inputmode: 'tel', autocomplete: 'off', dir: 'ltr', 'aria-describedby': 'cphone-help',
  });
  const btn = h('button.btn.primary', { type: 'submit', disabled: !services.length }, 'שמירת התור');

  const save = busy(btn, async () => {
    for (const el of [durInput, date, time, name, phone]) clearFieldError(el);
    if (!chosen.size) {
      servicesError.textContent = 'בחרי לפחות טיפול אחד';
      servicesError.hidden = false;
      servicesError.scrollIntoView({ block: 'center' });
      serviceList[0]?.querySelector('input')?.focus();
      return;
    }
    if (durInput.value !== '' && !(Number.isInteger(Number(durInput.value)) && Number(durInput.value) >= 5 && Number(durInput.value) <= 600)) {
      return fieldError(durInput, 'משך בדקות שלמות, בין 5 ל-600, או להשאיר ריק');
    }
    if (!date.value) return fieldError(date, 'בחרי תאריך');
    if (!time.value) return fieldError(time, 'בחרי שעה');
    if (!name.value.trim()) return fieldError(name, 'צריך שם של הלקוחה');
    if (phone.value.trim() && !isMobile(phone.value)) return fieldError(phone, 'מספר נייד לא תקין. למשל 050-1234567');
    const start = zonedToDate(date.value, time.value);
    if (start < new Date() && !window.confirm('השעה כבר עברה — לשמור בכל זאת?')) return;
    const { error } = await state.sb.rpc('owner_book_appointment', {
      p_business: state.business.id,
      p_items: [...chosen].map(([service_id, qty]) => ({ service_id, qty })),
      p_start: start.toISOString(),
      p_name: name.value.trim(),
      p_phone: phone.value.trim() || null,
      p_duration_min: durInput.value ? Number(durInput.value) : null,
    });
    if (error) {
      const msg = error.message || '';
      if (/SLOT_TAKEN/.test(msg)) return fieldError(time, 'יש כבר תור בזמן הזה. בחרי שעה אחרת או משך קצר יותר.');
      if (/INVALID_PHONE/.test(msg)) return fieldError(phone, errorText(error));
      if (/INVALID_DURATION/.test(msg)) return fieldError(durInput, errorText(error));
      if (/NAME_REQUIRED/.test(msg)) return fieldError(name, errorText(error));
      return showError(error);
    }
    toast('התור נשמר');
    go(`#/owner?d=${date.value}`);
  });
  recompute();

  const servicesCard = services.length
    ? h('div.card.stack', h('h3', 'טיפול'), serviceList, servicesError, totals)
    : h('div.card.stack', h('h3', 'טיפול'),
      h('p', 'אין טיפולים פעילים במחירון, ולכן אי אפשר לקבוע תור.'),
      h('a.btn.secondary', { href: '#/owner/settings/services' }, 'למחירון'));

  mount(h('main.page',
    header('תור ידני', { back: params.d ? `#/owner?d=${params.d}` : '#/owner' }),
    h('form.stack', { onsubmit: (e) => { e.preventDefault(); save(); }, novalidate: true },
      servicesCard,
      h('div.card.stack',
        // תאריך ושעה זה מתחת לזה: בצד לצד, ב-320 פיקסלים התאריך נחתך («11.2026»).
        h('div.stack.tight', h('label.label', { for: 'date' }, 'תאריך'), date),
        h('div.stack.tight', h('label.label', { for: 'time' }, 'שעה'), time),
        h('label.label', { for: 'dur' }, 'משך בדקות (אם שונה מהרגיל)'), durInput,
        h('p.note', 'בתור ידני מותר לחרוג משעות העבודה. רק חפיפה עם תור אחר נחסמת.')),
      h('div.card.stack',
        h('label.label', { for: 'cname' }, 'שם הלקוחה'), name,
        h('label.label', { for: 'cphone' }, 'טלפון (לא חובה)'), phone,
        h('p.note', { id: 'cphone-help' }, 'נייד בלבד, למשל ', ltr('050-1234567'), '. עם טלפון — הלקוחה תקבל אישור ותזכורת, והתור יופיע אצלה כשתתחבר.')),
      btn)));
}

// ───────────────────────── הגדרות ─────────────────────────

const SECTIONS = [
  ['business', 'פרטי העסק', 'שם, כתובת וטלפון ליצירת קשר'],
  ['hours', 'שעות עבודה', 'ימים, שעות והפסקות'],
  ['services', 'טיפולים ומחירים', 'משך, מחיר, הוספה והסתרה'],
  ['timeoff', 'חופשות וחסימות', 'ימים ושעות שבהם אי אפשר לקבוע'],
  ['rules', 'כללי הזמנה', 'כמה מראש, מרווח בין תורים, שעת תזכורת'],
  ['notify', 'התראות', 'הודעה לטלפון שלך על כל תור חדש'],
  ['link', 'קישור ללקוחות', 'הקישור שמפיצים בוואטסאפ ובאינסטגרם'],
];

export function settings() {
  mount(h('main.page',
    header('הגדרות', { back: '#/owner' }),
    h('nav.menu', SECTIONS.map(([key, title, desc]) =>
      h('a.menu-item', { href: `#/owner/settings/${key}` }, h('strong', title), h('span.muted', desc)))),
    h('button.btn.ghost', { type: 'button', onclick: logout }, 'התנתקות')));
}

export async function settingsSection(params, key) {
  const fn = { business, hours, services, timeoff, rules, notify, link }[key];
  if (!fn) return go('#/owner/settings', { replace: true });
  const title = SECTIONS.find((s) => s[0] === key)[1];
  mount(h('main.page', header(title, { back: '#/owner/settings' }), h('div.center', spinner())));
  const body = await fn(params);
  mount(h('main.page', header(title, { back: '#/owner/settings' }), body));
}

const field = (label, input) => h('div.stack.tight', h('label.label', { for: input.id }, label), input);

async function updateSettings(patch) {
  const { data, error } = await state.sb.from('settings')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('business_id', state.business.id).select().single();
  if (error) throw error;
  state.settings = data;
}

function business() {
  const name = h('input.field', { id: 'bname', value: state.business.name, maxlength: 60, required: true });
  const address = h('input.field', { id: 'addr', value: state.settings.address, maxlength: 120 });
  const phone = h('input.field', {
    id: 'bphone', type: 'tel', inputmode: 'tel', dir: 'ltr', maxlength: 15,
    value: phoneDisplay(state.settings.contact_phone) || state.settings.contact_phone || '',
  });
  const btn = h('button.btn.primary', { type: 'submit' }, 'שמירה');
  const save = busy(btn, async () => {
    for (const el of [name, phone]) clearFieldError(el);
    const newName = name.value.trim();
    if (!newName) return fieldError(name, 'צריך שם לעסק');
    if (phone.value.trim() && !isPhone(phone.value)) return fieldError(phone, 'מספר טלפון לא תקין. למשל 050-1234567 או 03-1234567');
    const patch = { address: address.value.trim(), contact_phone: phone.value.replace(/[^\d+]/g, '') };
    const oldName = state.business.name;
    const nameChanged = newName !== oldName;
    const settingsChanged = patch.address !== (state.settings.address || '') || patch.contact_phone !== (state.settings.contact_phone || '');
    if (!nameChanged && !settingsChanged) return toast('אין שינויים לשמור');

    // שני שלבים (שם בטבלת העסק, כתובת וטלפון בהגדרות). אם השני נכשל — מחזירים את השם, כדי לא להשאיר חצי מצב.
    if (nameChanged) {
      const { error } = await state.sb.from('businesses').update({ name: newName }).eq('id', state.business.id);
      if (error) return showError(error);
    }
    if (settingsChanged) {
      try {
        await updateSettings(patch);
      } catch (e) {
        console.error(e);
        if (!nameChanged) return showError(e);
        const { error: undo } = await state.sb.from('businesses').update({ name: oldName }).eq('id', state.business.id);
        if (undo) {
          state.business.name = newName;
          return toast('שם העסק נשמר, אבל הכתובת והטלפון לא נשמרו. לחצי «שמירה» שוב.', 'error');
        }
        return toast(`לא הצלחתי לשמור, ושום דבר לא השתנה. ${errorText(e)}`, 'error');
      }
    }
    try { await loadBusiness(); } catch (e) { console.error(e); }
    toast('נשמר');
  });
  return h('form.card.stack', { onsubmit: (e) => { e.preventDefault(); save(); }, novalidate: true },
    field('שם העסק', name),
    field('כתובת (מופיעה ללקוחה באישור)', address),
    field('טלפון ליצירת קשר (לכפתור "צרי קשר")', phone),
    btn);
}

// אזהרה לפני יציאה ממסך עם שינויים שלא נשמרו: לחיצה על קישור או על «חזרה», וסגירה/רענון של הדף.
// כפתור «אחורה» של הטלפון נעצר דרך setLeaveGuard בנתב.
function leaveGuard(anchor, isDirty, message) {
  let seen = false;
  setTimeout(() => { seen = true; }, 0);
  const gone = () => {
    if (anchor.isConnected) return false;
    if (seen) release();
    return true;
  };
  const onClick = (e) => {
    if (gone() || !isDirty()) return;
    const t = e.target.closest?.('a[href], button.back');
    if (!t || anchor.contains(t)) return;
    if (window.confirm(message)) release();
    else { e.preventDefault(); e.stopImmediatePropagation(); }
  };
  const onUnload = (e) => {
    if (gone() || !isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  };
  function release() {
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('beforeunload', onUnload);
    setLeaveGuard(null);
  }
  document.addEventListener('click', onClick, true);
  window.addEventListener('beforeunload', onUnload);
  setLeaveGuard(() => gone() || !isDirty() || window.confirm(message));
}

async function hours() {
  const { data, error } = await state.sb.from('working_hours').select('*').eq('business_id', state.business.id).order('start_time');
  if (error) throw error;
  const model = Array.from({ length: 7 }, (_, wd) => data.filter((r) => r.weekday === wd)
    .map((r) => ({ start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5) })));
  const clone = (ranges) => ranges.map((r) => ({ ...r }));
  // הטווחים האחרונים של כל יום, כדי שכיבוי והדלקה יחזירו פיצול כמו 09–13 + 16–20.
  const memory = model.map(clone);
  let saved = JSON.stringify(model);
  const dayDirty = (wd) => JSON.stringify(model[wd]) !== JSON.stringify(JSON.parse(saved)[wd]);
  const isDirty = () => JSON.stringify(model) !== saved;

  const wrap = h('div.stack');
  const cards = [];   // לפי יום: { card, inputs: [{ start, end }] }
  const unsavedNote = h('p.note', { hidden: true, role: 'status' }, 'יש שינויים שלא נשמרו.');
  const refreshMarks = () => {
    cards.forEach((c, wd) => c.card.classList.toggle('unsaved', dayDirty(wd)));
    unsavedNote.hidden = !isDirty();
  };

  const dayCard = (wd) => {
    const ranges = model[wd];
    const open = ranges.length > 0;
    const day = `יום ${dayName(wd)}`;
    const toggle = h('input', { type: 'checkbox', checked: open, id: `wd-${wd}` });
    toggle.onchange = () => {
      if (toggle.checked) {
        model[wd] = memory[wd].length ? clone(memory[wd]) : [{ start: '09:00', end: '19:00' }];
      } else {
        if (ranges.length) memory[wd] = clone(ranges);
        model[wd] = [];
      }
      rerenderDay(wd, `#wd-${wd}`);
    };
    const inputs = ranges.map((r, i) => {
      const n = ranges.length > 1 ? `, טווח ${i + 1}` : '';
      const set = (k) => (e) => { r[k] = e.target.value; memory[wd] = clone(ranges); refreshMarks(); };
      return {
        start: h('input.field', { type: 'time', step: 900, value: r.start, 'aria-label': `${day}${n}: משעה`, oninput: set('start') }),
        end: h('input.field', { type: 'time', step: 900, value: r.end, 'aria-label': `${day}${n}: עד שעה`, oninput: set('end') }),
      };
    });
    const addRange = () => {
      const prev = ranges.at(-1);
      const s0 = prev?.end ? Math.min(hhmmToMin(prev.end) + 60, 22 * 60 + 45) : 16 * 60;
      ranges.push({ start: minToHhmm(s0), end: minToHhmm(Math.min(s0 + 180, 23 * 60 + 45)) });
      memory[wd] = clone(ranges);
      rerenderDay(wd);
      cards[wd].inputs.at(-1)?.start.focus();
    };
    const card = h('div.card.stack.tight', { 'data-day': wd },
      h('label.check-row', { for: `wd-${wd}` }, toggle, h('strong.grow', day), h('span.muted', open ? '' : 'סגור')),
      ranges.map((r, i) => h('div.row.range',
        inputs[i].start,
        h('span', 'עד'),
        inputs[i].end,
        // טווח יחיד לא מסירים מכאן — סוגרים את היום בתיבת הסימון (וכך יש יותר מקום לשעות ב-320).
        ranges.length < 2 ? null : h('button.icon-btn', {
          type: 'button',
          'aria-label': `הסרת הטווח ${r.start || ''}–${r.end || ''}, ${day}`,
          onclick: () => {
            ranges.splice(i, 1);
            if (ranges.length) memory[wd] = clone(ranges);
            rerenderDay(wd);
          },
        }, icon('close')))),
      open ? h('button.link', { type: 'button', onclick: addRange }, icon('plus'), ' טווח נוסף (למשל אחרי הפסקה)') : null);
    return { card, inputs };
  };

  const rerenderDay = (wd, focusSel) => {
    const next = dayCard(wd);
    cards[wd].card.replaceWith(next.card);
    cards[wd] = next;
    refreshMarks();
    if (focusSel) next.card.querySelector(focusSel)?.focus();
  };

  for (let wd = 0; wd < 7; wd++) cards[wd] = dayCard(wd);
  wrap.replaceChildren(...cards.map((c) => c.card));

  // בדיקה לפני שמירה: טווח שלם, סיום אחרי התחלה, ובלי חפיפה באותו יום. מחזירה את השגיאה הראשונה.
  const validate = () => {
    for (let wd = 0; wd < 7; wd++) {
      const day = `יום ${dayName(wd)}`;
      const { inputs } = cards[wd];
      const rs = model[wd].map((r, i) => ({ ...r, i }));
      for (const r of rs) {
        if (!r.start) return [inputs[r.i].start, `${day}: חסרה שעת התחלה`];
        if (!r.end) return [inputs[r.i].end, `${day}: חסרה שעת סיום`];
        if (r.start >= r.end) return [inputs[r.i].end, `${day}: שעת הסיום צריכה להיות אחרי שעת ההתחלה`];
      }
      rs.sort((a, b) => (a.start < b.start ? -1 : 1));
      for (let k = 1; k < rs.length; k++) {
        if (rs[k].start < rs[k - 1].end) {
          return [inputs[rs[k].i].start, `${day}: הטווחים חופפים. כל טווח צריך להתחיל אחרי שהקודם נגמר.`];
        }
      }
    }
    return null;
  };

  const btn = h('button.btn.primary', { type: 'button' }, 'שמירת שעות העבודה');
  btn.onclick = busy(btn, async () => {
    const bad = validate();
    if (bad) return fieldError(...bad);
    const rows = model.flatMap((ranges, wd) => [...ranges].sort((a, b) => (a.start < b.start ? -1 : 1))
      .map((r) => ({ weekday: wd, start_time: r.start, end_time: r.end })));
    const { error: e } = await state.sb.rpc('set_working_hours', { p_business: state.business.id, p_rows: rows });
    if (e) return showError(e);
    saved = JSON.stringify(model);
    refreshMarks();
    toast('שעות העבודה נשמרו');
  });
  const body = h('div.stack', h('p.note', 'תורים שכבר נקבעו לא משתנים כשמשנים שעות.'), wrap, unsavedNote, btn);
  leaveGuard(body, isDirty, 'יש שינויים בשעות העבודה שלא נשמרו. לצאת בלי לשמור?');
  return body;
}

async function services() {
  await loadBusiness();
  const list = h('div.stack');
  let newCount = 0;

  // מצב החצים: הראשון לא עולה, האחרון לא יורד, והכול נעול בזמן הזזה.
  let moving = false;
  const updateArrows = () => {
    const cards = [...list.querySelectorAll('[data-service]')];
    cards.forEach((c, i) => {
      c.querySelector('.move-up').disabled = moving || i === 0;
      c.querySelector('.move-down').disabled = moving || i === cards.length - 1;
    });
  };

  const editor = (s, isNew = false) => {
    const key = isNew ? `new${++newCount}` : s.id;
    const name = h('input.field', { id: `sn-${key}`, value: s.name || '', maxlength: 80, required: true });
    const dur = h('input.field', { id: `sd-${key}`, type: 'number', min: 1, max: 600, value: s.duration_min || '', inputmode: 'numeric', required: true });
    const price = h('input.field', { id: `sp-${key}`, type: 'number', min: 0, max: 100000, value: s.price ?? '', inputmode: 'numeric', required: true });
    const perUnit = h('input', { type: 'checkbox', checked: s.price_type === 'per_unit' });
    const active = h('input', { type: 'checkbox', checked: isNew ? true : s.active });
    const btn = h('button.btn.primary.small', { type: 'button' }, isNew ? 'הוספה' : 'שמירה');

    const values = () => JSON.stringify([name.value, dur.value, price.value, perUnit.checked, active.checked]);
    const initial = values();

    btn.onclick = busy(btn, async () => {
      for (const el of [name, dur, price]) clearFieldError(el);
      const row = {
        name: name.value.trim(),
        duration_min: Number(dur.value),
        price: Number(price.value),
        price_type: perUnit.checked ? 'per_unit' : 'fixed',
        active: active.checked,
      };
      if (!row.name) return fieldError(name, 'צריך שם לטיפול');
      if (dur.value === '' || !Number.isInteger(row.duration_min) || row.duration_min < 1 || row.duration_min > 600) {
        return fieldError(dur, 'משך בדקות, בין 1 ל-600');
      }
      if (price.value === '' || !Number.isInteger(row.price) || row.price < 0 || row.price > 100000) {
        return fieldError(price, 'מחיר בשקלים שלמים, 0 ומעלה');
      }
      const q = isNew
        ? state.sb.from('services').insert({ ...row, business_id: state.business.id, sort_order: state.services.length + 1 }).select().single()
        : state.sb.from('services').update(row).eq('id', s.id).select().single();
      const { data: saved, error } = await q;
      if (error) return showError(error);
      toast(isNew ? 'הטיפול נוסף' : 'נשמר');
      await loadBusiness();
      // מרעננים רק את הכרטיס הזה — עריכות פתוחות בכרטיסים אחרים נשארות.
      const fresh = state.services.find((x) => x.id === saved.id) || saved;
      if (isNew) {
        card.before(editor(fresh));
        card.replaceWith(editor({ price_type: 'fixed' }, true));
      } else {
        card.replaceWith(editor(fresh));
      }
      updateArrows();
    });

    const moveBtn = (dir, cls, label, iconName) => {
      const b = h(`button.icon-btn.${cls}`, { type: 'button', 'aria-label': `${label} — ${s.name}` }, icon(iconName));
      const run = busy(b, async () => {
        if (moving) return;
        const cards = [...list.querySelectorAll('[data-service]')];
        const i = cards.indexOf(card);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= cards.length) return;
        const ids = cards.map((c) => c.dataset.service);
        [ids[i], ids[j]] = [ids[j], ids[i]];
        moving = true;
        updateArrows();
        try {
          const results = await Promise.all(ids.map((id, idx) => state.sb.from('services').update({ sort_order: idx + 1 }).eq('id', id)));
          const bad = results.find((r) => r.error);
          if (bad) {
            showError(bad.error);
            // חלק מהעדכונים אולי נשמרו — מסדרים את הכרטיסים לפי מה שבמסד (בלי לבנות אותם מחדש).
            try {
              await loadBusiness();
              const byId = new Map(cards.map((c) => [c.dataset.service, c]));
              const newEditor = list.lastElementChild;
              for (const x of state.services) if (byId.has(x.id)) newEditor.before(byId.get(x.id));
            } catch (e) { console.error(e); }
            return;
          }
          if (dir < 0) cards[j].before(card); else cards[j].after(card);
          await loadBusiness();
          b.focus();
        } finally {
          moving = false;
        }
      });
      // busy מדליק את הכפתור בסוף, ולכן מצב החצים נקבע רק אחריו (חץ בקצה נשאר כבוי).
      b.onclick = async () => { await run(); updateArrows(); };
      return b;
    };

    const card = h('div.card.stack.tight', { class: !isNew && !s.active ? 'dim' : '', 'data-service': isNew ? null : s.id },
      isNew ? h('h3', 'טיפול חדש') : null,
      h('div.stack.tight', h('label.label', { for: name.id }, 'שם הטיפול'), name),
      h('div.row',
        h('div.grow', h('label.label', { for: dur.id }, 'משך (דק׳)'), dur),
        h('div.grow', h('label.label', { for: price.id }, 'מחיר (₪)'), price)),
      h('label.check-row', perUnit, h('span', 'מחיר ומשך לפי יחידה (למשל לכל ציפורן)')),
      h('label.check-row', active, h('span', 'מוצג ללקוחות')),
      h('div.row.spread',
        isNew ? h('span') : h('div.row', moveBtn(-1, 'move-up', 'הזזה למעלה', 'up'), moveBtn(1, 'move-down', 'הזזה למטה', 'down')),
        btn));
    card.addEventListener('input', () => card.classList.toggle('unsaved', values() !== initial));
    card.addEventListener('change', () => card.classList.toggle('unsaved', values() !== initial));
    return card;
  };

  list.replaceChildren(
    ...state.services.map((s) => editor(s)),
    editor({ price_type: 'fixed' }, true));
  updateArrows();
  return h('div.stack', h('p.note', 'טיפול שלא רוצים להציע — מורידים את הסימון "מוצג ללקוחות". תורים שכבר נקבעו לא משתנים.'), list);
}

// תיאור של חסימה לתצוגה: { text: אלמנטים לדף, plain: טקסט לחלון אישור }.
function offText(startTs, endTs) {
  const lastDay = new Date(new Date(endTs) - 1);
  const sameDay = dateKey(startTs) === dateKey(lastDay);
  const fullDays = timeText(startTs) === '00:00' && timeText(endTs) === '00:00';
  const d = (ts) => `יום ${dayName(weekdayOf(dateKey(ts)))} ${shortDate(ts)}`;
  if (fullDays && sameDay) return { text: [d(startTs), ' · כל היום'], plain: `${d(startTs)}, כל היום` };
  if (fullDays) {
    const r = range(shortDate(startTs), shortDate(lastDay));
    return { text: [ltr(r), ' · ימים שלמים'], plain: `${ltrPlain(r)}, ימים שלמים` };
  }
  if (sameDay) {
    const r = range(timeText(startTs), timeText(endTs));
    return { text: [d(startTs), ' ', ltr(r)], plain: `${d(startTs)}, ${ltrPlain(r)}` };
  }
  const a = `${shortDate(startTs)} ${timeText(startTs)}`;
  const b = `${shortDate(endTs)} ${timeText(endTs)}`;
  return { text: ['מ-', ltr(a), ' עד ', ltr(b)], plain: `מ-${ltrPlain(a)} עד ${ltrPlain(b)}` };
}

async function timeoff() {
  const wrap = h('div.stack');
  const load = async () => {
    const { data, error } = await state.sb.from('time_off').select('*').eq('business_id', state.business.id)
      .gt('end_at', new Date().toISOString()).order('start_at');
    if (error) throw error;
    return data;
  };

  const fromDate = h('input.field', { type: 'date', id: 'fd', value: todayKey(), min: todayKey(), required: true });
  const toDate = h('input.field', { type: 'date', id: 'td', value: todayKey(), min: todayKey(), required: true });
  const allDay = h('input', { type: 'checkbox', checked: true, id: 'allday' });
  const fromTime = h('input.field', { type: 'time', id: 'ft', step: 900, value: '09:00', 'aria-label': 'משעה' });
  const toTime = h('input.field', { type: 'time', id: 'tt', step: 900, value: '13:00', 'aria-label': 'עד שעה' });
  const fromLabel = h('label.label', { for: 'fd' });
  const toLabel = h('label.label', { for: 'td' });
  const preview = h('p.note', { 'aria-live': 'polite' });
  const reason = h('input.field', { id: 'reason', placeholder: 'למשל: חופשה', maxlength: 60 });
  const warn = h('div.stack');
  const btn = h('button.btn.primary', { type: 'button' }, 'הוספת חסימה');

  // הטווח המדויק שייחסם. כש«ימים שלמים» כבוי — רצף אחד מהתאריך והשעה הראשונים ועד האחרונים, כולל הלילות.
  const span = () => {
    if (!fromDate.value || !toDate.value) return null;
    if (allDay.checked) return [zonedToDate(fromDate.value, '00:00'), zonedToDate(addDays(toDate.value, 1), '00:00')];
    if (!fromTime.value || !toTime.value) return null;
    return [zonedToDate(fromDate.value, fromTime.value), zonedToDate(toDate.value, toTime.value)];
  };

  const sync = () => {
    toDate.min = fromDate.value || todayKey();
    if (fromDate.value && toDate.value < fromDate.value) toDate.value = fromDate.value;
    fromTime.hidden = allDay.checked;
    toTime.hidden = allDay.checked;
    fromLabel.textContent = allDay.checked ? 'מתאריך' : 'מתאריך ושעה';
    toLabel.textContent = allDay.checked ? 'עד תאריך (כולל)' : 'עד תאריך ושעה';
    const sp = span();
    if (!sp) { preview.replaceChildren('בחרי תאריכים ושעות.'); return; }
    if (!(sp[1] > sp[0])) { preview.replaceChildren('הסיום צריך להיות אחרי ההתחלה.'); return; }
    const t = offText(sp[0], sp[1]);
    const multi = !allDay.checked && dateKey(sp[0]) !== dateKey(new Date(sp[1] - 1));
    preview.replaceChildren(h('strong', 'ייחסם: '), ...t.text, multi ? ' — ברצף אחד, כולל הלילות.' : '');
  };
  for (const el of [fromDate, toDate, fromTime, toTime]) el.addEventListener('input', sync);
  for (const el of [fromDate, toDate, allDay]) el.addEventListener('change', sync);
  sync();

  btn.onclick = busy(btn, async () => {
    for (const el of [fromDate, toDate, fromTime, toTime]) clearFieldError(el);
    if (!fromDate.value) return fieldError(fromDate, 'בחרי תאריך התחלה');
    if (!toDate.value) return fieldError(toDate, 'בחרי תאריך סיום');
    if (toDate.value < fromDate.value) return fieldError(toDate, 'תאריך הסיום לפני תאריך ההתחלה');
    if (!allDay.checked && !fromTime.value) return fieldError(fromTime, 'בחרי שעת התחלה');
    if (!allDay.checked && !toTime.value) return fieldError(toTime, 'בחרי שעת סיום');
    const [start, end] = span();
    if (!(end > start)) return fieldError(allDay.checked ? toDate : toTime, 'הסיום צריך להיות אחרי ההתחלה');
    const { error } = await state.sb.from('time_off').insert({
      business_id: state.business.id, start_at: start.toISOString(), end_at: end.toISOString(), reason: reason.value.trim(),
    });
    if (error) return showError(error);

    // תורים שכבר קבועים בזמן החסום — לא מבוטלים אוטומטית. מציגים אותם כדי שתטפלי בהם.
    const { data: clash, error: clashError } = await state.sb.from('appointments').select('*').eq('business_id', state.business.id)
      .eq('status', 'booked').lt('start_at', end.toISOString()).gt('end_at', start.toISOString()).order('start_at');
    if (clashError) {
      console.error(clashError);
      warn.replaceChildren(h('div.card.warn.stack', { role: 'alert' },
        h('strong', 'החסימה נוספה, אבל לא הצלחתי לבדוק תורים חופפים.'),
        h('p', 'כדאי לבדוק ביומן אם יש תורים בזמן שחסמת — הם לא מבוטלים אוטומטית.')));
    } else {
      warn.replaceChildren(...(clash.length ? [
        h('div.card.warn.stack', { role: 'alert' },
          h('strong', `שימי לב: יש ${countText(clash.length, 'תור אחד', 'תורים')} בזמן שחסמת. ${clash.length === 1 ? 'הוא לא בוטל' : 'הם לא בוטלו'}.`),
          clash.map((a) => h('div.row.spread',
            h('a.link', { href: `#/owner/appt/${a.id}` }, ltr(`${shortDate(a.start_at)} ${timeText(a.start_at)}`), ` · ${a.customer_name}`),
            a.customer_phone ? h('a.link', { href: waLink(a.customer_phone), target: '_blank', rel: 'noopener' }, 'וואטסאפ') : null))),
      ] : []));
    }
    toast('החסימה נוספה');
    reason.value = '';
    try { renderList(await load()); } catch (e) { showError(e); }
  });

  const listEl = h('div.stack');
  const renderList = (rows) => {
    listEl.replaceChildren(...(rows.length ? rows.map((o) => {
      const t = offText(o.start_at, o.end_at);
      const del = h('button.icon-btn', { type: 'button', 'aria-label': `מחיקת החסימה ${t.plain}` }, icon('close'));
      del.onclick = busy(del, async () => {
        if (!window.confirm(`למחוק את החסימה?\n\n${t.plain}${o.reason ? `\n${o.reason}` : ''}\n\nאחרי המחיקה לקוחות יוכלו לקבוע בזמן הזה.`)) return;
        const { error } = await state.sb.from('time_off').delete().eq('id', o.id);
        if (error) return showError(error);
        toast('החסימה נמחקה');
        try { renderList(await load()); } catch (e) { showError(e); }
      });
      return h('div.card.row.spread', h('span', h('strong', ...t.text), o.reason ? h('span.muted', ` · ${o.reason}`) : null), del);
    }) : [h('p.muted', 'אין חסימות קרובות.')]));
  };
  renderList(await load());

  wrap.append(
    h('div.card.stack',
      h('h3', 'חסימה חדשה'),
      h('label.check-row', { for: 'allday' }, allDay, h('span', 'ימים שלמים')),
      h('div.stack.tight', fromLabel, h('div.row', h('div.grow', fromDate), fromTime)),
      h('div.stack.tight', toLabel, h('div.row', h('div.grow', toDate), toTime)),
      preview,
      field('סיבה (רק את רואה)', reason),
      btn),
    warn,
    h('h3', 'חסימות קרובות'),
    listEl);
  return wrap;
}

function rules() {
  const s = state.settings;
  const num = (id, value, min, max, step = 1) => h('input.field', { id, type: 'number', value, min, max, step, inputmode: 'decimal', required: true });
  const windowDays = num('win', s.booking_window_days, 1, 365);
  const notice = num('notice', s.min_notice_min / 60, 0, 168, 0.5);
  const buffer = num('buffer', s.buffer_min, 0, 120, 5);
  const step = h('select.field', { id: 'step' }, [10, 15, 20, 30, 60].map((v) => h('option', { value: v, selected: v === s.slot_step_min }, `כל ${v} דקות`)));
  const reminder = h('input.field', { id: 'rem', type: 'time', step: 900, value: s.reminder_time.slice(0, 5), required: true });
  const btn = h('button.btn.primary', { type: 'submit' }, 'שמירה');

  // שדה ריק לא נשמר כ-0: כל שדה חובה ובתוך הטווח שלו.
  const check = (input, min, max, { integer = true, unit }) => {
    const v = input.value.trim();
    if (v === '') return [input, 'שדה חובה'];
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
      return [input, `${integer ? 'מספר שלם ' : ''}בין ${min} ל-${max} ${unit}`];
    }
    return null;
  };

  const save = busy(btn, async () => {
    for (const el of [windowDays, notice, buffer, reminder]) clearFieldError(el);
    const bad = check(windowDays, 1, 365, { unit: 'ימים' })
      || check(notice, 0, 168, { integer: false, unit: 'שעות' })
      || check(buffer, 0, 120, { unit: 'דקות' })
      || (reminder.value ? null : [reminder, 'בחרי שעה']);
    if (bad) return fieldError(...bad);
    try {
      await updateSettings({
        booking_window_days: Number(windowDays.value),
        min_notice_min: Math.round(Number(notice.value) * 60),
        buffer_min: Number(buffer.value),
        slot_step_min: Number(step.value),
        reminder_time: reminder.value,
      });
      toast('נשמר');
    } catch (e) { showError(e); }
  });
  return h('form.card.stack', { onsubmit: (e) => { e.preventDefault(); save(); }, novalidate: true },
    field('כמה ימים קדימה אפשר לקבוע', windowDays),
    field('כמה שעות לפחות לפני התור אפשר לקבוע', notice),
    field('מרווח בין תורים (דקות)', buffer),
    field('השעות שמוצעות ללקוחה', step),
    field('שעת התזכורת ביום שלפני התור', reminder),
    btn);
}

// ───────────────────────── התראות פוש ─────────────────────────

const b64ToBytes = (b64) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

async function enablePush() {
  if (!state.cfg.vapidPublic) throw new Error('push not configured');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    toast('ההתראות לא אושרו בטלפון. אפשר לאשר בהגדרות הדפדפן.', 'error');
    return false;
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(state.cfg.vapidPublic) });
  const json = sub.toJSON();
  const { error } = await state.sb.from('push_subscriptions').upsert({
    business_id: state.business.id, profile_id: state.profile.id,
    endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth,
  }, { onConflict: 'endpoint' });
  if (error) throw error;
  const { error: e2 } = await state.sb.rpc('push_test', { p_business: state.business.id });
  if (e2) throw e2;
  toast('ההתראות הופעלו — תגיע אלייך הודעת בדיקה');
  return true;
}

function pushBanner() {
  if (!pushSupported() || !state.cfg.vapidPublic || Notification.permission === 'granted') return null;
  try { if (localStorage.getItem('push-banner-hidden') === '1') return null; } catch { /* מצב פרטי */ }
  const el = h('div.card.banner',
    h('span.grow', 'רוצה לקבל הודעה על כל תור חדש?'),
    h('a.btn.primary.small', { href: '#/owner/settings/notify' }, 'הפעלה'),
    h('button.icon-btn', { type: 'button', 'aria-label': 'סגירה', onclick: () => { try { localStorage.setItem('push-banner-hidden', '1'); } catch { /* מצב פרטי */ } el.remove(); } }, icon('close')));
  return el;
}

function notify() {
  const box = h('div.stack');
  if (!state.cfg.vapidPublic) {
    box.append(h('p.note', 'ההתראות עוד לא הוגדרו בשרת.'));
    return box;
  }
  if (isIos() && !isStandalone()) {
    box.append(h('div.card.stack',
      h('strong', 'באייפון צריך קודם להתקין את האפליקציה:'),
      h('ol.steps', h('li', 'לוחצים על כפתור השיתוף (ריבוע עם חץ) בתחתית ספארי'), h('li', 'בוחרים "הוספה למסך הבית"'), h('li', 'פותחים את האפליקציה מהאייקון וחוזרים למסך הזה'))));
    return box;
  }
  if (!pushSupported()) {
    box.append(h('p.note', 'הדפדפן הזה לא תומך בהתראות. נסי מכרום (אנדרואיד) או מהאפליקציה המותקנת (אייפון).'));
    return box;
  }
  const btn = h('button.btn.primary', { type: 'button' }, Notification.permission === 'granted' ? 'שליחת הודעת בדיקה' : 'הפעלת התראות');
  btn.onclick = busy(btn, async () => {
    try { await enablePush(); } catch (e) { showError(e); }
  });
  box.append(h('div.card.stack',
    h('p', 'תקבלי הודעה לטלפון על כל תור חדש שלקוחה קובעת, ועל כל ביטול.'),
    btn,
    h('p.note', 'צריך להפעיל בכל טלפון שאיתו את עובדת.')));
  return box;
}

function link() {
  const url = location.origin + '/';
  const msg = `היי! כדי לקבוע תור אצלי פשוט נכנסים לקישור ובוחרים טיפול ושעה: ${url}`;
  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); toast('הועתק'); } catch { toast('לא הצלחתי להעתיק', 'error'); }
  };
  return h('div.stack',
    h('div.card.stack',
      h('h3', 'הקישור לקביעת תור'),
      h('p.url', ltr(url)),
      h('div.row',
        h('button.btn.secondary', { type: 'button', onclick: () => copy(url) }, 'העתקה'),
        navigator.share ? h('button.btn.secondary', { type: 'button', onclick: () => navigator.share({ title: state.business.name, url }).catch(() => {}) }, 'שיתוף') : null)),
    h('div.card.stack',
      h('h3', 'הודעה למענה האוטומטי בוואטסאפ ביזנס'),
      h('p.quote', msg.slice(0, -url.length), ltr(url)),
      h('button.btn.secondary', { type: 'button', onclick: () => copy(msg) }, 'העתקת ההודעה'),
      h('p.note', 'בוואטסאפ ביזנס: הגדרות ← כלים לעסקים ← הודעת פתיחה / מענה אוטומטי.')));
}
