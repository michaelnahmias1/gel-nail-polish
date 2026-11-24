// כלים משותפים לכל המסכים: יצירת אלמנטים, תאריכים בשעון ישראל, הודעות.

export const TZ = 'Asia/Jerusalem';

// h('button.big', {onclick}, 'טקסט', child...) — יוצר אלמנט עם מחלקות, מאפיינים וילדים.
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += ' ' + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function mount(...nodes) {
  const root = document.getElementById('app');
  root.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

let toastTimer;
export function toast(text, kind = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = text;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3500);
}

// הודעות שגיאה מהמסד → עברית פשוטה.
const ERRORS = {
  SLOT_TAKEN: 'השעה הזו כבר נתפסה. בחרי שעה אחרת.',
  ALREADY_BOOKED: 'כבר יש לך תור עתידי. אפשר לבטל אותו ולקבוע חדש.',
  CANCEL_TOO_LATE: 'ביום התור כבר אי אפשר לבטל באפליקציה. צרי קשר.',
  NAME_REQUIRED: 'צריך למלא שם.',
  NOT_LOGGED_IN: 'צריך להתחבר מחדש.',
  NO_SERVICES: 'בחרי טיפול.',
  INVALID_SERVICES: 'אחד הטיפולים כבר לא זמין. בחרי שוב.',
  INVALID_PHONE: 'מספר הטלפון לא תקין.',
  INVALID_DURATION: 'משך לא תקין.',
  INVALID_TIME: 'בחרי תאריך ושעה.',
  INVALID_HOURS: 'שעות העבודה לא תקינות. בדקי ששעת הסיום אחרי שעת ההתחלה.',
  NOT_OWNER: 'רק בעלת העסק יכולה לעשות את זה.',
  NOT_FOUND: 'התור לא נמצא.',
  BAD_CLAIM_CODE: 'קוד ההקמה לא נכון.',
};

export function errorText(e) {
  const msg = String(e?.message || e || '');
  for (const [code, text] of Object.entries(ERRORS)) if (msg.includes(code)) return text;
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'אין חיבור לאינטרנט. נסי שוב.';
  if (/JWT|token/i.test(msg)) return 'צריך להתחבר מחדש.';
  return 'משהו השתבש. נסי שוב.';
}

export const showError = (e) => { console.error(e); toast(errorText(e), 'error'); };

// ───────── תאריכים ושעות, תמיד בשעון ישראל ─────────

const dateKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const weekdayFmt = new Intl.DateTimeFormat('he-IL', { timeZone: TZ, weekday: 'long' });
const shortDateFmt = new Intl.DateTimeFormat('he-IL', { timeZone: TZ, day: 'numeric', month: 'numeric' });
const longDateFmt = new Intl.DateTimeFormat('he-IL', { timeZone: TZ, day: 'numeric', month: 'long' });

export const dateKey = (d) => dateKeyFmt.format(new Date(d));          // 2027-01-05
export const timeText = (d) => timeFmt.format(new Date(d));            // 10:30
export const weekdayText = (d) => weekdayFmt.format(new Date(d));      // יום שלישי
export const shortDate = (d) => shortDateFmt.format(new Date(d));      // 5.1
export const longDate = (d) => longDateFmt.format(new Date(d));        // 5 בינואר

// "צהריים" של תאריך מקומי — נוח לחישובים על ימים בלי ליפול על מעברי שעון.
export const noonOf = (key) => new Date(`${key}T12:00:00Z`);
export const addDays = (key, n) => {
  const d = noonOf(key);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const todayKey = () => dateKey(Date.now());
export const weekdayOf = (key) => noonOf(key).getUTCDay(); // 0 = ראשון

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const dayName = (wd) => DAY_NAMES[wd];

export function dayLabel(key) {
  const t = todayKey();
  if (key === t) return 'היום';
  if (key === addDays(t, 1)) return 'מחר';
  return `יום ${dayName(weekdayOf(key))}`;
}

// היסט (בדקות) של שעון ישראל מ-UTC ברגע נתון.
function tzOffsetMin(utcMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return Math.round((asUtc - utcMs) / 60000);
}

// תאריך ושעה מקומיים (שעון ישראל) → Date. מטפל נכון בשעון קיץ.
export function zonedToDate(key, hhmm) {
  const [y, m, d] = key.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - tzOffsetMin(guess) * 60000;
  ts = guess - tzOffsetMin(ts) * 60000;
  return new Date(ts);
}

export const money = (n) => `₪${n}`;
export function minutesText(min) {
  if (min < 60) return `${min} דק׳`;
  const hrs = Math.floor(min / 60);
  const rest = min % 60;
  const hText = hrs === 1 ? 'שעה' : hrs === 2 ? 'שעתיים' : `${hrs} שעות`;
  return rest ? `${hText} ו-${rest} דק׳` : hText;
}

export function phoneDisplay(p) {
  if (!p) return '';
  const local = p.replace(/^\+972/, '0');
  return local.length === 10 ? `${local.slice(0, 3)}-${local.slice(3)}` : local;
}
export const waLink = (p, text = '') =>
  `https://wa.me/${String(p || '').replace(/\D/g, '').replace(/^0/, '972')}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

export function itemsText(items) {
  return (items || []).map((i) => (i.qty > 1 ? `${i.name} ×${i.qty}` : i.name)).join(' + ');
}

// כפתור שמונע לחיצה כפולה בזמן שהפעולה רצה.
export function busy(btn, fn) {
  return async (...args) => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('loading');
    try {
      return await fn(...args);
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  };
}

export function header(title, { back } = {}) {
  return h('header.top',
    back ? h('button.back', { type: 'button', 'aria-label': 'חזרה', onclick: () => (typeof back === 'string' ? (location.hash = back) : history.back()) }, '→') : h('span.back-space'),
    h('h1', title),
    h('span.back-space'));
}

export function spinner() {
  return h('div.spinner', { role: 'progressbar', 'aria-label': 'טוען' });
}
