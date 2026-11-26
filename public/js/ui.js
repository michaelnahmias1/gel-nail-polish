// כלים משותפים לכל המסכים: יצירת אלמנטים, תאריכים בשעון ישראל, הודעות.

import { icon } from './icons.js';

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

let appName = '';
export const setAppName = (name) => { appName = name || ''; };

// מחליף את תוכן המסך. אם הפוקוס היה על משהו שנמחק — עובר לכותרת המסך החדש,
// וכותרת הלשונית בדפדפן מתעדכנת לפי המסך (data-title על השורש, או ה-h1 הראשון).
export function mount(...nodes) {
  const root = document.getElementById('app');
  const hadFocus = root.contains(document.activeElement);
  root.replaceChildren(...nodes);
  window.scrollTo(0, 0);
  const heading = root.querySelector('h1');
  const title = nodes[0]?.dataset?.title || heading?.textContent?.trim();
  document.title = title && title !== appName ? `${title} · ${appName}` : appName || title || document.title;
  const active = document.activeElement;
  if (heading && (hadFocus || !active || active === document.body || !document.contains(active))) {
    // הכותרת אינה כפתור — מקבלת פוקוס רק כדי שקורא מסך יתחיל ממנה, בלי מסגרת פוקוס.
    heading.setAttribute('tabindex', '-1');
    heading.style.outline = 'none';
    heading.focus({ preventScroll: true });
  }
}

// אזור ההודעות (toast) נוצר כבר בטעינת הדף, כדי שקוראי מסך יקראו גם את ההודעה הראשונה.
const toastEl = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
document.body.append(toastEl);
let toastTimer;
// kind: '' (הצלחה / מידע) או 'error'. שגיאות נשארות על המסך יותר זמן.
export function toast(text, kind = '') {
  toastEl.textContent = text;
  toastEl.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, kind === 'error' ? 7000 : 3500);
}

// ───────── שגיאה ליד שדה ─────────

let fieldUid = 0;
const errId = (input) => `${input.id}-error`;

// fieldError(input, 'הודעה') — מסמן את השדה כשגוי, מציג את ההודעה מתחתיו ומקשר ביניהם,
// גולל אל השדה ומעביר אליו פוקוס. שגיאה קודמת באותו שדה מוחלפת. נמחקת לבד כשמקלידים.
export function fieldError(input, message) {
  clearFieldError(input);
  if (!input.id) input.id = `field-${++fieldUid}`;
  const wasFocused = document.activeElement === input;
  const p = h('p.field-error', { id: errId(input) }, message);
  // אם השדה כבר בפוקוס, המעבר אליו לא יקריא את ההודעה — אז מכריזים עליה.
  if (wasFocused) p.setAttribute('role', 'alert');
  input.after(p);
  input.setAttribute('aria-invalid', 'true');
  const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  input.setAttribute('aria-describedby', [...ids, p.id].join(' '));
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  input.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  if (!wasFocused) input.focus({ preventScroll: true });
  input.addEventListener('input', () => clearFieldError(input), { once: true });
  return p;
}

export function clearFieldError(input) {
  if (!input?.id) return;
  input.removeAttribute('aria-invalid');
  document.getElementById(errId(input))?.remove();
  const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== errId(input));
  if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
  else input.removeAttribute('aria-describedby');
}

// ───────── ניווט ─────────
// כל כניסה בהיסטוריה מקבלת מספר (history.state.idx), ורשימת הכתובות נשמרת ב-sessionStorage.
// כך אפשר לדעת לאן «חזרה» תוביל, ולחזור באמת אחורה במקום להוסיף צעד חדש.

const NAV_KEY = 'gel-nav';
let router = () => {};
let navIdx = -1;
let navStack = [];
let pendingPush = null;
try { navStack = JSON.parse(sessionStorage.getItem(NAV_KEY)) || []; } catch { navStack = []; }
const saveNav = () => { try { sessionStorage.setItem(NAV_KEY, JSON.stringify(navStack)); } catch { /* מצב פרטי */ } };

export const currentHash = () => location.hash || '#/';
const pathOf = (hash) => String(hash || '').split('?')[0];

export function setRouter(fn) { router = fn; }

// שומר יציאה: מסך עם שינויים שלא נשמרו רושם פונקציה שמחזירה true אם מותר לצאת.
// הנתב בודק אותה לפני כל מעבר — גם בכפתור «אחורה» של הטלפון — ואם אסור, מחזיר את הכתובת.
let leaveGuardFn = null;
let reverting = false;
export function setLeaveGuard(fn) { leaveGuardFn = fn || null; }
// מסיר את השומר רק אם הוא עדיין של המסך הזה (מאזין ישן לא ימחק שומר של ביקור חדש).
export function clearLeaveGuard(fn) { if (leaveGuardFn === fn) leaveGuardFn = null; }
export function passLeaveGuard() {
  if (reverting) { reverting = false; return false; }
  if (!leaveGuardFn) return true;
  if (leaveGuardFn()) { leaveGuardFn = null; return true; }
  const st = history.state;
  const delta = st && Number.isInteger(st.idx) ? navIdx - st.idx : -1;
  if (delta) { reverting = true; history.go(delta); }
  return false;
}

// נקרא בתחילת כל ניתוב. מחזיר false אם צריך מיד לעבור למסך אחר (ואז אין לצייר את הנוכחי).
export function trackNavigation() {
  const st = history.state;
  if (st && Number.isInteger(st.idx)) {
    navIdx = st.idx;
  } else {
    navIdx += 1;
    history.replaceState({ ...(st && typeof st === 'object' ? st : {}), idx: navIdx }, '');
    navStack.length = navIdx;
  }
  navStack[navIdx] = currentHash();
  saveNav();
  if (pendingPush) {
    const target = pendingPush;
    pendingPush = null;
    if (target !== currentHash()) {
      location.hash = target;
      return false;
    }
  }
  return true;
}

// go('#/x')                  — מעבר רגיל. אם המסך הקודם בהיסטוריה הוא בדיוק '#/x', חוזרים אליו במקום להוסיף צעד.
// go('#/x', {replace: true}) — הפניה: מחליפה את הצעד הנוכחי, כך ש«חזרה» לא תחזיר לכאן.
export function go(hash, { replace = false } = {}) {
  if (replace) {
    // שואלים לפני שמחליפים את הכתובת — אחרת «להישאר» משאיר כתובת של מסך אחר.
    if (!passLeaveGuard()) return;
    history.replaceState({ idx: navIdx }, '', hash);
    return router();
  }
  if (hash === currentHash()) return router();
  if (navIdx > 0 && navStack[navIdx - 1] === hash) return history.back();
  location.hash = hash;
}

const findBack = (target) => {
  for (let k = 1; k <= navIdx; k++) if (navStack[navIdx - k] === target) return k;
  for (let k = 1; k <= navIdx; k++) if (pathOf(navStack[navIdx - k]) === pathOf(target)) return k;
  return 0;
};

// חזרה למסך target: אם הוא כבר מאחורינו בהיסטוריה — חוזרים אליו באמת; אחרת מחליפים את הצעד הנוכחי.
export function goBack(target = '#/') {
  const k = findBack(target);
  if (k) return history.go(-k);
  return go(target, { replace: true });
}

// חוזר אחורה עד base (אם הוא בהיסטוריה) ומשם עובר ל-hash. משמש אחרי פעולה שמסיימת תהליך
// (למשל «התור נקבע!»), כדי ש«חזרה» לא תוביל שוב לשלבי התהליך.
export function goFrom(base, hash) {
  const k = findBack(base);
  if (!k) return go(hash, { replace: true });
  pendingPush = hash;
  history.go(-k);
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
  if (/Failed to fetch|NetworkError|network|Load failed/i.test(msg)) {
    return navigator.onLine === false ? 'אין חיבור לאינטרנט. נסי שוב.' : 'לא הצלחנו להתחבר. נסי שוב.';
  }
  if (/JWT|token/i.test(msg)) return 'צריך להתחבר מחדש.';
  return 'משהו השתבש. נסי שוב.';
}

export const showError = (e) => { console.error(e); toast(errorText(e), 'error'); };

export const isOffline = () => navigator.onLine === false;

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

// כפתור שמונע לחיצה כפולה בזמן שהפעולה רצה (ומסמן אותו כ«עובד» גם לקוראי מסך).
export function busy(btn, fn) {
  return async (...args) => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('busy', 'loading');
    btn.setAttribute('aria-busy', 'true');
    try {
      return await fn(...args);
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy', 'loading');
      btn.removeAttribute('aria-busy');
    }
  };
}

// טקסט שמשמאל לימין (טלפון, שעה, טווח שעות) בתוך שורה בעברית.
export const ltr = (text) => h('bdi.ltr', { dir: 'ltr' }, text);

// back: מחרוזת = לאן החץ מוביל (חוזר אליו באמת אם הוא בהיסטוריה); true = צעד אחד אחורה.
export function header(title, { back } = {}) {
  const onBack = () => {
    if (typeof back === 'string') return goBack(back);
    if (navIdx > 0) return history.back();
    return goBack('#/');
  };
  return h('header.top',
    back ? h('button.back', { type: 'button', 'aria-label': 'חזרה', onclick: onBack }, icon('back')) : h('span.back-space'),
    h('h1', title),
    h('span.back-space'));
}

export function spinner() {
  return h('div.spinner', { role: 'progressbar', 'aria-label': 'טוען' });
}
