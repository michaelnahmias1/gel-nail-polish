// מסכי בעלת העסק: יומן שבועי, פרטי תור, תור ידני, הגדרות, ורישום ראשוני כבעלת העסק.
import {
  h, mount, header, spinner, toast, showError, errorText, busy, fieldError, clearFieldError,
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
    go('#/owner');
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

async function renderCalendar(params, { silent }) {
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
  // בזמן הטעינה עברו למסך אחר — לא דורסים אותו.
  if (silent && !document.querySelector('main[data-view="calendar"]')) return;

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
}

function offRow(o, k) {
  const fromStart = dateKey(o.start_at) !== k;          // התחילה ביום קודם
  const toEnd = dateKey(o.end_at) !== k;                // נמשכת אחרי חצות
  const when = fromStart && toEnd ? 'כל היום'
    : ltr(range(fromStart ? '00:00' : timeText(o.start_at), toEnd ? '24:00' : timeText(o.end_at)));
  return h('div.off-row', icon('block'), ' חסום',
    o.reason ? ` · ${o.reason}` : '',
    ' ', h('span.muted', when));
}

function ownerTop() {
  const refresh = h('button.icon-btn', { type: 'button', 'aria-label': 'רענון היומן' }, icon('refresh'));
  refresh.onclick = busy(refresh, async () => {
    try {
      await renderCalendar(calendarParams || {}, { silent: true });
      toast('היומן עודכן');
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
    if (durInput.value !== '' && !(Number(durInput.value) >= 5 && Number(durInput.value) <= 600)) {
      return fieldError(durInput, 'משך בין 5 ל-600 דקות, או להשאיר ריק');
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
        h('div.row',
          h('div.grow', h('label.label', { for: 'date' }, 'תאריך'), date),
          h('div.grow', h('label.label', { for: 'time' }, 'שעה'), time)),
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
  if (!fn) return go('#/owner/settings');
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
  const name = h('input.field', { id: 'bname', value: state.business.name, maxlength: 60 });
  const address = h('input.field', { id: 'addr', value: state.settings.address, maxlength: 120 });
  const phone = h('input.field', { id: 'bphone', type: 'tel', value: phoneDisplay(state.settings.contact_phone) || state.settings.contact_phone, maxlength: 15 });
  const btn = h('button.btn.primary', { type: 'submit' }, 'שמירה');
  const save = busy(btn, async () => {
    try {
      if (!name.value.trim()) return toast('צריך שם לעסק', 'error');
      const { error } = await state.sb.from('businesses').update({ name: name.value.trim() }).eq('id', state.business.id);
      if (error) throw error;
      await updateSettings({ address: address.value.trim(), contact_phone: phone.value.replace(/[^\d+]/g, '') });
      await loadBusiness();
      toast('נשמר');
    } catch (e) { showError(e); }
  });
  return h('form.card.stack', { onsubmit: (e) => { e.preventDefault(); save(); } },
    field('שם העסק', name),
    field('כתובת (מופיעה ללקוחה באישור)', address),
    field('טלפון ליצירת קשר (לכפתור "צרי קשר")', phone),
    btn);
}

async function hours() {
  const { data, error } = await state.sb.from('working_hours').select('*').eq('business_id', state.business.id).order('start_time');
  if (error) throw error;
  const model = Array.from({ length: 7 }, (_, wd) => data.filter((r) => r.weekday === wd)
    .map((r) => ({ start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5) })));
  const wrap = h('div.stack');

  const render = () => {
    wrap.replaceChildren(...model.map((ranges, wd) => {
      const open = ranges.length > 0;
      const toggle = h('input', { type: 'checkbox', checked: open, id: `wd-${wd}` });
      toggle.onchange = () => {
        model[wd] = toggle.checked ? [{ start: '09:00', end: '19:00' }] : [];
        render();
      };
      return h('div.card.stack.tight',
        h('label.check-row', { for: `wd-${wd}` }, toggle, h('strong.grow', `יום ${dayName(wd)}`), h('span.muted', open ? '' : 'סגור')),
        ranges.map((r, i) => h('div.row.range',
          h('input.field', { type: 'time', step: 900, value: r.start, 'aria-label': 'משעה', oninput: (e) => { r.start = e.target.value; } }),
          h('span', 'עד'),
          h('input.field', { type: 'time', step: 900, value: r.end, 'aria-label': 'עד שעה', oninput: (e) => { r.end = e.target.value; } }),
          h('button.icon-btn', { type: 'button', 'aria-label': 'הסרה', onclick: () => { ranges.splice(i, 1); render(); } }, '✕'))),
        open ? h('button.link', { type: 'button', onclick: () => { ranges.push({ start: ranges.at(-1)?.end || '16:00', end: '19:00' }); render(); } }, '+ טווח נוסף (למשל אחרי הפסקה)') : null);
    }));
  };
  render();

  const btn = h('button.btn.primary', { type: 'button' }, 'שמירת שעות העבודה');
  btn.onclick = busy(btn, async () => {
    const rows = model.flatMap((ranges, wd) => ranges.map((r) => ({ weekday: wd, start_time: r.start, end_time: r.end })));
    if (rows.some((r) => !r.start_time || !r.end_time || r.start_time >= r.end_time)) {
      return toast('בכל טווח, שעת הסיום צריכה להיות אחרי שעת ההתחלה', 'error');
    }
    const { error: e } = await state.sb.rpc('set_working_hours', { p_business: state.business.id, p_rows: rows });
    if (e) return showError(e);
    toast('שעות העבודה נשמרו');
  });
  return h('div.stack', h('p.note', 'תורים שכבר נקבעו לא משתנים כשמשנים שעות.'), wrap, btn);
}

async function services() {
  await loadBusiness();
  const list = h('div.stack');

  const editor = (s, isNew = false) => {
    const name = h('input.field', { value: s.name || '', maxlength: 80, placeholder: 'שם הטיפול', 'aria-label': 'שם' });
    const dur = h('input.field', { type: 'number', min: 1, max: 600, value: s.duration_min || '', inputmode: 'numeric', 'aria-label': 'משך בדקות' });
    const price = h('input.field', { type: 'number', min: 0, max: 100000, value: s.price ?? '', inputmode: 'numeric', 'aria-label': 'מחיר' });
    const perUnit = h('input', { type: 'checkbox', checked: s.price_type === 'per_unit' });
    const active = h('input', { type: 'checkbox', checked: isNew ? true : s.active });
    const btn = h('button.btn.primary.small', { type: 'button' }, isNew ? 'הוספה' : 'שמירה');
    btn.onclick = busy(btn, async () => {
      const row = {
        name: name.value.trim(),
        duration_min: Number(dur.value),
        price: Number(price.value),
        price_type: perUnit.checked ? 'per_unit' : 'fixed',
        active: active.checked,
      };
      if (!row.name || !(row.duration_min > 0) || !(row.price >= 0) || price.value === '') {
        return toast('צריך שם, משך ומחיר', 'error');
      }
      const q = isNew
        ? state.sb.from('services').insert({ ...row, business_id: state.business.id, sort_order: state.services.length + 1 })
        : state.sb.from('services').update(row).eq('id', s.id);
      const { error } = await q;
      if (error) return showError(error);
      toast('נשמר');
      await loadBusiness();
      render();
    });
    const move = (dir) => async () => {
      const arr = [...state.services];
      const i = arr.findIndex((x) => x.id === s.id);
      const j = i + dir;
      if (j < 0 || j >= arr.length) return;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      const results = await Promise.all(arr.map((x, idx) => state.sb.from('services').update({ sort_order: idx + 1 }).eq('id', x.id)));
      const bad = results.find((r) => r.error);
      if (bad) return showError(bad.error);
      await loadBusiness();
      render();
    };
    return h('div.card.stack.tight', { class: !isNew && !s.active ? 'dim' : '' },
      isNew ? h('h3', 'טיפול חדש') : null,
      name,
      h('div.row',
        h('div.grow', h('span.label', 'משך (דק׳)'), dur),
        h('div.grow', h('span.label', 'מחיר (₪)'), price)),
      h('label.check-row', perUnit, h('span', 'מחיר ומשך לפי יחידה (למשל לכל ציפורן)')),
      h('label.check-row', active, h('span', 'מוצג ללקוחות')),
      h('div.row.spread',
        isNew ? h('span') : h('div.row',
          h('button.icon-btn', { type: 'button', 'aria-label': 'למעלה', onclick: move(-1) }, '↑'),
          h('button.icon-btn', { type: 'button', 'aria-label': 'למטה', onclick: move(1) }, '↓')),
        btn));
  };

  const render = () => {
    list.replaceChildren(
      ...state.services.map((s) => editor(s)),
      editor({ price_type: 'fixed' }, true));
  };
  render();
  return h('div.stack', h('p.note', 'טיפול שלא רוצים להציע — מורידים את הסימון "מוצג ללקוחות". תורים שכבר נקבעו לא משתנים.'), list);
}

async function timeoff() {
  const wrap = h('div.stack');
  const load = async () => {
    const { data, error } = await state.sb.from('time_off').select('*').eq('business_id', state.business.id)
      .gt('end_at', new Date().toISOString()).order('start_at');
    if (error) throw error;
    return data;
  };

  const fromDate = h('input.field', { type: 'date', id: 'fd', value: todayKey(), min: todayKey() });
  const toDate = h('input.field', { type: 'date', id: 'td', value: todayKey(), min: todayKey() });
  const allDay = h('input', { type: 'checkbox', checked: true, id: 'allday' });
  const fromTime = h('input.field', { type: 'time', step: 900, value: '09:00', 'aria-label': 'משעה' });
  const toTime = h('input.field', { type: 'time', step: 900, value: '13:00', 'aria-label': 'עד שעה' });
  const timesRow = h('div.row.range', { hidden: true }, fromTime, h('span', 'עד'), toTime);
  allDay.onchange = () => { timesRow.hidden = allDay.checked; };
  fromDate.onchange = () => { if (toDate.value < fromDate.value) toDate.value = fromDate.value; };
  const reason = h('input.field', { id: 'reason', placeholder: 'למשל: חופשה', maxlength: 60 });
  const warn = h('div.stack');
  const btn = h('button.btn.primary', { type: 'button' }, 'הוספת חסימה');

  btn.onclick = busy(btn, async () => {
    if (!fromDate.value || !toDate.value) return toast('בחרי תאריכים', 'error');
    const start = allDay.checked ? zonedToDate(fromDate.value, '00:00') : zonedToDate(fromDate.value, fromTime.value);
    const end = allDay.checked ? zonedToDate(addDays(toDate.value, 1), '00:00') : zonedToDate(toDate.value, toTime.value);
    if (!(end > start)) return toast('הסיום צריך להיות אחרי ההתחלה', 'error');
    const { error } = await state.sb.from('time_off').insert({
      business_id: state.business.id, start_at: start.toISOString(), end_at: end.toISOString(), reason: reason.value.trim(),
    });
    if (error) return showError(error);

    // תורים שכבר קבועים בזמן החסום — לא מבוטלים אוטומטית. מציגים אותם כדי שתטפלי בהם.
    const { data: clash } = await state.sb.from('appointments').select('*').eq('business_id', state.business.id)
      .eq('status', 'booked').lt('start_at', end.toISOString()).gt('end_at', start.toISOString()).order('start_at');
    warn.replaceChildren(...(clash?.length ? [
      h('div.card.warn.stack',
        h('strong', `שימי לב: יש ${clash.length === 1 ? 'תור אחד' : `${clash.length} תורים`} בזמן שחסמת. הם לא בוטלו.`),
        clash.map((a) => h('div.row.spread',
          h('a.link', { href: `#/owner/appt/${a.id}` }, `${shortDate(a.start_at)} ${timeText(a.start_at)} · ${a.customer_name}`),
          a.customer_phone ? h('a.link', { href: waLink(a.customer_phone), target: '_blank', rel: 'noopener' }, 'וואטסאפ') : null))),
    ] : []));
    toast('החסימה נוספה');
    reason.value = '';
    renderList(await load());
  });

  const listEl = h('div.stack');
  const renderList = (rows) => {
    listEl.replaceChildren(...(rows.length ? rows.map((o) => {
      const del = h('button.icon-btn', { type: 'button', 'aria-label': 'מחיקה' }, '✕');
      del.onclick = busy(del, async () => {
        if (!window.confirm('למחוק את החסימה?')) return;
        const { error } = await state.sb.from('time_off').delete().eq('id', o.id);
        if (error) return showError(error);
        renderList(await load());
      });
      const sameDay = dateKey(o.start_at) === dateKey(new Date(new Date(o.end_at) - 1));
      const fullDays = timeText(o.start_at) === '00:00' && timeText(o.end_at) === '00:00';
      const text = fullDays
        ? (sameDay ? `${shortDate(o.start_at)} · כל היום` : `${shortDate(o.start_at)}–${shortDate(new Date(new Date(o.end_at) - 1))}`)
        : `${shortDate(o.start_at)} ${timeText(o.start_at)} – ${sameDay ? '' : `${shortDate(o.end_at)} `}${timeText(o.end_at)}`;
      return h('div.card.row.spread', h('span', h('strong', text), o.reason ? h('span.muted', ` · ${o.reason}`) : null), del);
    }) : [h('p.muted', 'אין חסימות קרובות.')]));
  };
  renderList(await load());

  wrap.append(
    h('div.card.stack',
      h('h3', 'חסימה חדשה'),
      h('div.row',
        h('div.grow', h('label.label', { for: 'fd' }, 'מתאריך'), fromDate),
        h('div.grow', h('label.label', { for: 'td' }, 'עד תאריך'), toDate)),
      h('label.check-row', { for: 'allday' }, allDay, h('span', 'ימים שלמים')),
      timesRow,
      field('סיבה (רק את רואה)', reason),
      btn),
    warn,
    h('h3', 'חסימות קרובות'),
    listEl);
  return wrap;
}

function rules() {
  const s = state.settings;
  const num = (id, value, min, max, step = 1) => h('input.field', { id, type: 'number', value, min, max, step, inputmode: 'numeric' });
  const windowDays = num('win', s.booking_window_days, 1, 365);
  const notice = num('notice', s.min_notice_min / 60, 0, 168, 0.5);
  const buffer = num('buffer', s.buffer_min, 0, 120, 5);
  const step = h('select.field', { id: 'step' }, [10, 15, 20, 30, 60].map((v) => h('option', { value: v, selected: v === s.slot_step_min }, `כל ${v} דקות`)));
  const reminder = h('input.field', { id: 'rem', type: 'time', step: 900, value: s.reminder_time.slice(0, 5) });
  const btn = h('button.btn.primary', { type: 'submit' }, 'שמירה');
  const save = busy(btn, async () => {
    try {
      await updateSettings({
        booking_window_days: Math.round(Number(windowDays.value)),
        min_notice_min: Math.round(Number(notice.value) * 60),
        buffer_min: Math.round(Number(buffer.value)),
        slot_step_min: Number(step.value),
        reminder_time: reminder.value,
      });
      toast('נשמר');
    } catch (e) { showError(e); }
  });
  return h('form.card.stack', { onsubmit: (e) => { e.preventDefault(); save(); } },
    field('כמה ימים קדימה אפשר לקבוע', windowDays),
    field('כמה שעות לפחות לפני התור (התראה מינימלית)', notice),
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
  if (localStorage.getItem('push-banner-hidden') === '1') return null;
  const el = h('div.card.banner',
    h('span.grow', 'רוצה לקבל הודעה על כל תור חדש?'),
    h('a.btn.primary.small', { href: '#/owner/settings/notify' }, 'הפעלה'),
    h('button.icon-btn', { type: 'button', 'aria-label': 'סגירה', onclick: () => { localStorage.setItem('push-banner-hidden', '1'); el.remove(); } }, '✕'));
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
      h('bdi.url', url),
      h('div.row',
        h('button.btn.secondary', { type: 'button', onclick: () => copy(url) }, 'העתקה'),
        navigator.share ? h('button.btn.secondary', { type: 'button', onclick: () => navigator.share({ title: state.business.name, url }).catch(() => {}) }, 'שיתוף') : null)),
    h('div.card.stack',
      h('h3', 'הודעה למענה האוטומטי בוואטסאפ ביזנס'),
      h('p.quote', msg),
      h('button.btn.secondary', { type: 'button', onclick: () => copy(msg) }, 'העתקת ההודעה'),
      h('p.note', 'בוואטסאפ ביזנס: הגדרות ← כלים לעסקים ← הודעת פתיחה / מענה אוטומטי.')));
}
