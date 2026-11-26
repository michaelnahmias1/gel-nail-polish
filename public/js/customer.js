// מסכי הלקוחה: כניסה, שם, בית, קביעת תור (טיפול → יום ושעה → אישור), התורים שלי.
import {
  h, mount, header, spinner, toast, showError, errorText, busy, fieldError, clearFieldError, ltr,
  dateKey, timeText, weekdayText, shortDate, longDate, dayLabel, todayKey, addDays,
  money, minutesText, itemsText, waLink, phoneDisplay,
} from './ui.js';
import { icon } from './icons.js';
import { state, loadProfile, logout, go, goBack, goFrom, isOwner, afterLoginTarget, routeId } from './app.js';

// ───────────────────────── כניסה ─────────────────────────

const digitsOf = (s) => String(s || '').replace(/\D/g, '');
// אותן צורות שהמסד מקבל: 05XXXXXXXX, 5XXXXXXXX, 9725XXXXXXXX (גם עם +, רווחים ומקפים).
const looksLikeMobile = (d) => /^(05\d{8}|5\d{8}|9725\d{8})$/.test(d);
const RESEND_SEC = 30;

// לאן ממשיכים אחרי כניסה: למסך השם אם עוד אין שם, אחרת למסך ששמרנו (או לבית).
function continueAfterLogin() {
  if (!state.profile?.name) return go('#/name', { replace: true });
  return go(afterLoginTarget({ consume: true }), { replace: true });
}

export function login() {
  if (state.profile) return continueAfterLogin();
  let phone = '';        // המספר שאליו נשלח הקוד האחרון
  let lastAuto = '';     // הקוד האחרון שנשלח אוטומטית, כדי לא לשלוח אותו פעמיים
  let tick = null;

  // ───── שלב 1: מספר טלפון ─────
  const phoneInput = h('input.field', {
    id: 'phone', type: 'tel', inputmode: 'tel', autocomplete: 'tel',
    placeholder: '050-0000000', maxlength: 20,
  });
  const sendBtn = h('button.btn.primary', { type: 'submit' }, 'שליחת קוד');
  const phoneStep = h('form.stack', {
    novalidate: true,
    onsubmit: (e) => { e.preventDefault(); start(); },
  },
  h('label.label', { for: 'phone' }, 'מספר הטלפון שלך'),
  phoneInput,
  sendBtn);

  // שולח קוד למספר. מחזיר {r} בהצלחה, או {message} עם הסבר למה לא.
  const requestCode = async (p) => {
    const r = await api('start', { phone: p });
    if (r.status === 'ok') return { r };
    if (r.status === 'invalid_phone') return { message: 'המספר לא נראה כמו נייד ישראלי. בדקי ונסי שוב.' };
    if (r.status === 'rate_limited') return { message: 'נשלחו יותר מדי קודים למספר הזה. נסי שוב מאוחר יותר.' };
    return { message: 'לא הצלחנו לשלוח קוד כרגע. נסי שוב מאוחר יותר.' };
  };

  const start = busy(sendBtn, async () => {
    const typed = phoneInput.value.trim();
    const d = digitsOf(typed);
    if (d.length < 9) return fieldError(phoneInput, 'צריך מספר נייד מלא, למשל 050-1234567');
    if (!looksLikeMobile(d)) return fieldError(phoneInput, 'המספר לא נראה כמו נייד ישראלי. בדקי ונסי שוב.');
    try {
      const { r, message } = await requestCode(typed);
      if (message) return fieldError(phoneInput, message);
      phone = typed;
      showCodeStep(r);
    } catch (e) {
      showError(e);
    }
  });

  // ───── שלב 2: הקוד ─────
  const codeInput = h('input.field.code', {
    id: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
    maxlength: 12, placeholder: '••••••',
  });
  const enterBtn = h('button.btn.primary', { type: 'submit' }, 'כניסה');
  const sentText = h('p.lead');
  const demoBox = h('div');
  const otherBtn = h('button.link', { type: 'button', onclick: () => backToPhone() }, 'מספר אחר');
  const resend = h('button.link', { type: 'button', disabled: true }, 'שליחה חוזרת');
  const codeStep = h('form.stack', {
    hidden: true, novalidate: true,
    onsubmit: (e) => { e.preventDefault(); finish(); },
  },
  sentText,
  demoBox,
  h('label.label', { for: 'code' }, 'הקוד שקיבלת'),
  codeInput,
  enterBtn,
  h('div.row.spread', otherBtn, resend));

  // מה כתוב מעל הקוד: לאן נשלח, ובמצב בדיקה — הקוד עצמו.
  const showSent = (r) => {
    sentText.replaceChildren(
      r.channel === 'whatsapp' ? 'שלחנו קוד בוואטסאפ למספר ' : 'הקוד למספר ',
      ltr(phoneDisplay(phone)));
    demoBox.replaceChildren(r.demoCode
      ? h('div.demo', h('strong', 'מצב בדיקה'), ' — הוואטסאפ עוד לא מחובר, אז הקוד מוצג כאן: ',
        h('bdi.demo-code', r.demoCode))
      : '');
  };

  const stopCountdown = () => { clearInterval(tick); tick = null; };
  const countdownText = (left) => `שליחה חוזרת (0:${String(left).padStart(2, '0')})`;
  const startCountdown = () => {
    stopCountdown();
    let left = RESEND_SEC;
    resend.disabled = true;
    resend.textContent = countdownText(left);
    tick = setInterval(() => {
      // יצאנו מהמסך — אין מה לספור.
      if (!resend.isConnected) return stopCountdown();
      left--;
      if (left > 0) {
        resend.textContent = countdownText(left);
      } else {
        stopCountdown();
        resend.textContent = 'שליחה חוזרת';
        resend.disabled = false;
      }
    }, 1000);
  };

  const resetCode = () => {
    codeInput.value = '';
    lastAuto = '';
    clearFieldError(codeInput);
  };

  const showCodeStep = (r) => {
    showSent(r);
    resetCode();
    phoneStep.hidden = true;
    codeStep.hidden = false;
    startCountdown();
    codeInput.focus();
  };

  // «מספר אחר» — חוזרים לשלב הטלפון בלי לטעון את הדף מחדש; המספר נשאר בשדה.
  const backToPhone = () => {
    stopCountdown();
    resetCode();
    codeStep.hidden = true;
    phoneStep.hidden = false;
    phoneInput.focus();
    phoneInput.select();
  };

  // שליחה חוזרת: אותה בקשה, אבל נשארים בשלב הקוד.
  const doResend = busy(resend, async () => {
    resend.textContent = 'שולחים…';
    try {
      const { r, message } = await requestCode(phone);
      if (message) {
        toast(message, 'error');
        return false;
      }
      showSent(r);
      resetCode();
      toast('שלחנו קוד חדש');
      codeInput.focus();
      return true;
    } catch (e) {
      showError(e);
      return false;
    }
  });
  resend.addEventListener('click', async () => {
    if (resend.disabled) return;
    const ok = await doResend();
    if (!resend.isConnected) return;
    if (ok) startCountdown();
    else resend.textContent = 'שליחה חוזרת';
  });

  const finish = busy(enterBtn, async () => {
    const code = digitsOf(codeInput.value);
    if (code.length !== 6) return fieldError(codeInput, 'הקוד הוא 6 ספרות');
    try {
      const res = await api('finish', { phone, code });
      if (res.status !== 'ok') {
        fieldError(codeInput, 'הקוד לא נכון או שפג תוקפו. בדקי ונסי שוב, או בקשי קוד חדש.');
        codeInput.select();
        return;
      }
      const { error } = await state.sb.auth.setSession(res.session);
      if (error) throw error;
      await loadProfile();
      stopCountdown();
      continueAfterLogin();
    } catch (e) {
      showError(e);
    }
  });

  // כשיש 6 ספרות — נכנסים לבד (פעם אחת לכל קוד).
  const autoSubmit = () => {
    const code = digitsOf(codeInput.value);
    if (code.length !== 6 || code === lastAuto || enterBtn.disabled) return;
    lastAuto = code;
    finish();
  };
  // מקבלים גם «123 456» או «123-456»: משאירים רק ספרות.
  codeInput.addEventListener('input', () => {
    const d = digitsOf(codeInput.value).slice(0, 6);
    if (codeInput.value !== d) codeInput.value = d;
    autoSubmit();
  });
  codeInput.addEventListener('paste', (e) => {
    // הודבק קוד שלם (גם עם רווח/מקף או טקסט סביבו) — שמים בשדה רק את 6 הספרות.
    // הדבקה של חלק מהקוד עוברת כרגיל, וה-input למעלה ינקה אותה.
    const d = digitsOf(e.clipboardData?.getData('text'));
    if (d.length < 6) return;
    e.preventDefault();
    codeInput.value = d.slice(0, 6);
    clearFieldError(codeInput);
    autoSubmit();
  });

  const card = h('div.card', phoneStep, codeStep);
  mount(h('main.page.login', { 'data-title': 'כניסה' },
    h('div.brand', h('img.logo', { src: '/icons/icon.svg', alt: '' }), h('h1', state.business.name)),
    h('p.lead.center-text', 'קביעת תור בכמה לחיצות'),
    card,
    state.cfg.demoLogin ? h('p.note.center-text', 'גרסת תצוגה') : null));
  phoneInput.focus();
}

async function api(action, body) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });
  if (!res.ok) throw new Error('login ' + res.status);
  return res.json();
}

export function askName() {
  if (state.profile?.name) return go(afterLoginTarget({ consume: true }), { replace: true });
  const phone = state.profile?.phone;
  const input = h('input.field', {
    id: 'name', autocomplete: 'given-name', maxlength: 60, placeholder: 'שם',
    'aria-describedby': phone ? 'name-hint name-phone' : 'name-hint',
  });
  const btn = h('button.btn.primary', { type: 'submit' }, 'המשך');
  const save = busy(btn, async () => {
    const name = input.value.trim();
    if (!name) return fieldError(input, 'צריך למלא שם');
    const { data, error } = await state.sb.rpc('set_my_name', { p_name: name });
    if (error) return showError(error);
    state.profile = data;
    go(afterLoginTarget({ consume: true }), { replace: true });
  });

  const notMe = h('button.link', { type: 'button' }, 'זה לא המספר שלי');
  notMe.addEventListener('click', busy(notMe, async () => {
    try {
      await logout();
    } catch (e) {
      showError(e);
    }
  }));

  mount(h('main.page.login', { 'data-title': 'השם שלך' },
    h('div.brand', h('img.logo', { src: '/icons/icon.svg', alt: '' }), h('h1', state.business.name)),
    h('div.card', h('form.stack', { novalidate: true, onsubmit: (e) => { e.preventDefault(); save(); } },
      h('label.label', { for: 'name' }, 'איך קוראים לך?'),
      h('p.muted', { id: 'name-hint' }, 'השם יופיע בתור שלך, כדי שנדע מי מגיעה.'),
      phone ? h('p.muted', { id: 'name-phone' }, 'נכנסת עם המספר ', ltr(phoneDisplay(phone))) : null,
      input, btn)),
    h('p.center-text', notMe)));
  input.focus();
}

// ───────────────────────── בית ─────────────────────────

async function myUpcoming() {
  const { data, error } = await state.sb.from('appointments')
    .select('*').eq('status', 'booked').eq('customer_id', state.profile.id)
    .gt('end_at', new Date().toISOString()).order('start_at').limit(1);
  if (error) throw error;
  return data[0] || null;
}

// «קבעי תור» מתחיל תמיד בחירה חדשה, ומציג מיד מסך טעינה.
function startBooking(e) {
  e?.preventDefault();
  resetDraft();
  mount(h('main.page', header('איזה טיפול?', { back: '#/' }), h('div.center', spinner())));
  go('#/book');
}

export async function home() {
  mount(h('main.page.center', spinner()));
  const id = routeId();
  const next = await myUpcoming();
  if (id !== routeId()) return;
  const first = state.profile.name.split(' ')[0];

  mount(h('main.page', { 'data-title': 'דף הבית' },
    h('div.hello', h('img.logo.small', { src: '/icons/icon.svg', alt: '' }),
      h('div', h('p.muted', state.business.name), h('h1', `היי ${first}`))),
    next
      ? h('section.stack',
        h('h2', 'התור הקרוב שלך'),
        appointmentCard(next),
        h('a.btn.secondary', { href: '#/mine' }, 'פרטים וביטול'))
      : h('section.stack',
        h('a.btn.primary.huge', { href: '#/book', onclick: startBooking }, 'קבעי תור')),
    footer()));
}

function footer() {
  const s = state.settings;
  return h('footer.foot',
    s.address ? h('p.muted', icon('location'), ' ', s.address) : null,
    s.contact_phone
      ? h('a.link', { href: waLink(s.contact_phone, 'היי, יש לי שאלה'), target: '_blank', rel: 'noopener' },
        icon('whatsapp'), ' שאלה? כתבי לנו בוואטסאפ')
      : null,
    h('a.link', { href: '#/mine' }, 'התורים שלי'),
    h('button.link.muted', { type: 'button', onclick: logout }, 'התנתקות'));
}

function appointmentCard(a) {
  return h('div.card.appt',
    h('div.appt-when', h('strong', `${dayLabel(dateKey(a.start_at))} · ${longDate(a.start_at)}`), h('span.big-time', ltr(timeText(a.start_at)))),
    h('div.appt-what', itemsText(a.items)),
    h('div.muted', `${minutesText(Math.round((new Date(a.end_at) - new Date(a.start_at)) / 60000))} · ${money(a.total_price)}`));
}

// «ביום שלישי, 5 בינואר, בשעה 10:30»
const whenText = (d) => `ב${weekdayText(d)}, ${longDate(d)}, בשעה ${timeText(d)}`;

function contactLink(text, label = 'צרי קשר') {
  const phone = state.settings.contact_phone;
  if (!phone) return null;
  return h('a.btn.secondary', { href: waLink(phone, text), target: '_blank', rel: 'noopener' }, icon('whatsapp'), ` ${label}`);
}

// ───────────────────────── קביעת תור ─────────────────────────
// הבחירה (טיפולים, יום, שעה) נשמרת ב-sessionStorage עד שהתור נקבע, כך ש«חזרה» או רענון לא מוחקים אותה.

const DRAFT_KEY = 'gel-draft';
const activeServices = () => state.services.filter((s) => s.active);
const serviceById = (id) => state.services.find((s) => s.id === id);

function draft() {
  if (!state.draft) {
    try { state.draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY)); } catch { state.draft = null; }
  }
  if (!state.draft || !Array.isArray(state.draft.items)) state.draft = { items: [] };
  // טיפול שהוסר מהמחירון בינתיים — יוצא מהבחירה.
  state.draft.items = state.draft.items.filter((i) => serviceById(i.service_id)?.active);
  return state.draft;
}
function saveDraft() {
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(state.draft)); } catch { /* מצב פרטי */ }
}
function resetDraft() {
  state.draft = { items: [] };
  try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* מצב פרטי */ }
}

function draftTotals() {
  let duration = 0;
  let price = 0;
  for (const it of draft().items) {
    const s = serviceById(it.service_id);
    if (!s) continue;
    const qty = s.price_type === 'per_unit' ? it.qty || 1 : 1;
    duration += s.duration_min * qty;
    price += s.price * qty;
  }
  return { duration, price };
}

const itemText = (s, qty) => (s.price_type === 'per_unit' && qty > 1 ? `${s.name} ×${qty}` : s.name);

function draftText() {
  return draft().items.map((it) => {
    const s = serviceById(it.service_id);
    return s ? itemText(s, it.qty) : '';
  }).join(' + ');
}

export async function chooseServices(params) {
  const adding = params.add === '1';
  const title = () => (draft().items.length ? 'הוספת טיפול' : 'איזה טיפול?');
  const back = adding ? '#/book/time' : '#/';
  mount(h('main.page', header(title(), { back }), h('div.center', spinner())));
  const id = routeId();
  const upcoming = !isOwner() && await myUpcoming();
  if (id !== routeId()) return;
  if (upcoming) {
    toast('כבר יש לך תור עתידי. אפשר לבטל אותו כאן ולקבוע חדש.');
    return go('#/mine', { replace: true });
  }
  const d = draft();
  const services = activeServices();

  if (!services.length) {
    mount(h('main.page', header('איזה טיפול?', { back: '#/' }),
      h('div.card.stack',
        h('p.lead', 'אין כרגע טיפולים שאפשר לקבוע באפליקציה.'),
        h('p.muted', 'אפשר לכתוב לנו ונמצא לך תור.'),
        contactLink('היי, רציתי לקבוע תור', 'כתבי לנו בוואטסאפ'),
        h('button.btn.ghost', { type: 'button', onclick: () => goBack('#/') }, 'חזרה לדף הבית'))));
    return;
  }

  const toTime = () => { saveDraft(); go('#/book/time'); };
  const add = (s, qty) => {
    d.items = d.items.filter((i) => i.service_id !== s.id);
    d.items.push({ service_id: s.id, qty });
    toTime();
  };
  const remove = (s) => {
    d.items = d.items.filter((i) => i.service_id !== s.id);
    saveDraft();
    render(s.id);
  };

  const list = h('div.choices');
  const chosenLine = h('p.muted');
  const next = h('button.btn.primary', { type: 'button', onclick: toTime }, 'המשך לבחירת שעה');
  const heading = h('h1');

  const serviceRow = (s) => {
    const item = d.items.find((i) => i.service_id === s.id);
    if (item) {
      return h('div.choice.selected', { 'data-id': s.id },
        h('span.choice-name', itemText(s, item.qty)),
        h('span.choice-meta', h('span.chosen-mark', icon('check'), ' נבחר'), ' · ',
          h('button.link', { type: 'button', 'aria-label': `הסרת ${s.name}`, onclick: () => remove(s) }, 'הסרה')));
    }
    if (s.price_type === 'per_unit') {
      let qty = 1;
      const count = h('span.qty-n', { 'aria-live': 'polite' }, '1');
      const label = h('span.muted');
      const refresh = () => {
        count.textContent = qty;
        label.textContent = `${minutesText(s.duration_min * qty)} · ${money(s.price * qty)}`;
      };
      refresh();
      const panel = h('div.qty-panel', { hidden: true, id: `qty-${s.id}` },
        h('p.muted', 'כמה ציפורניים?'),
        h('div.qty',
          h('button.round', { type: 'button', 'aria-label': 'פחות', onclick: () => { qty = Math.max(1, qty - 1); refresh(); } }, '−'),
          count,
          h('button.round', { type: 'button', 'aria-label': 'יותר', onclick: () => { qty = Math.min(10, qty + 1); refresh(); } }, '+')),
        label,
        h('button.btn.primary', { type: 'button', onclick: () => add(s, qty) }, 'הוספה'));
      const toggle = h('button.choice', {
        type: 'button', 'data-id': s.id, 'aria-expanded': 'false', 'aria-controls': panel.id,
        onclick: () => { panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded', String(!panel.hidden)); },
      },
      h('span.choice-name', s.name),
      h('span.choice-meta', `${money(s.price)} ליחידה`));
      return h('div.choice-wrap', toggle, panel);
    }
    return h('button.choice', { type: 'button', 'data-id': s.id, onclick: () => add(s, 1) },
      h('span.choice-name', s.name),
      h('span.choice-meta', `${minutesText(s.duration_min)} · ${money(s.price)}`));
  };

  const render = (focusId) => {
    heading.textContent = title();
    list.replaceChildren(...services.map(serviceRow));
    chosenLine.hidden = !d.items.length;
    chosenLine.textContent = d.items.length ? `בחרת: ${draftText()}. אפשר להוסיף עוד טיפול או להמשיך.` : '';
    next.hidden = !d.items.length;
    if (focusId) list.querySelector(`button.choice[data-id="${focusId}"]`)?.focus();
  };
  render();

  const top = header('', { back });
  top.querySelector('h1').replaceWith(heading);
  mount(h('main.page', top, chosenLine, list, next));
}

const PARTS = [['בוקר', 0], ['צהריים', 12], ['ערב', 17]];

export async function chooseTime() {
  const d = draft();
  if (!d.items.length) return go('#/book', { replace: true });
  mount(h('main.page', header('מתי נוח לך?', { back: '#/book' }), h('div.center', spinner())));

  const from = todayKey();
  const to = addDays(from, state.settings.booking_window_days);
  const id = routeId();
  const { data, error } = await state.sb.rpc('get_free_slots', {
    p_business: state.business.id, p_items: d.items, p_from: from, p_to: to,
  });
  if (id !== routeId()) return;
  if (error) throw error;

  const byDay = new Map();
  for (const { slot_start } of data) {
    const k = dateKey(slot_start);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(slot_start);
  }
  const days = [...byDay.keys()];
  const { duration, price } = draftTotals();

  const summary = h('div.summary',
    h('div', h('strong', draftText()), h('div.muted', `${minutesText(duration)} · ${money(price)}`)),
    h('a.btn.secondary', { href: '#/book?add=1' }, icon('plus'), ' עוד טיפול'));

  if (!days.length) {
    mount(h('main.page', header('מתי נוח לך?', { back: '#/book' }), summary,
      h('div.card.stack',
        h('p.lead', 'אין שעות פנויות בתקופה הקרובה.'),
        d.items.length > 1 ? h('p.muted', 'אפשר לנסות עם פחות טיפולים — לתור קצר יותר יש יותר שעות פנויות.') : null,
        h('button.btn.primary', { type: 'button', onclick: () => goBack('#/book') }, 'חזרה לבחירת טיפול'),
        contactLink('היי, רציתי לקבוע תור ולא מצאתי שעה פנויה', 'כתבי לנו בוואטסאפ'))));
    return;
  }

  let selected = d.day && byDay.has(d.day) ? d.day : days[0];
  const strip = h('div.days', { role: 'group', 'aria-label': 'בחירת יום' });
  const times = h('div.slot-groups', { 'aria-live': 'polite' });

  const renderTimes = () => {
    const slots = byDay.get(selected);
    const groups = PARTS.map(([name, fromHour], i) => {
      const toHour = PARTS[i + 1]?.[1] ?? 24;
      const inPart = slots.filter((t) => {
        const hour = Number(timeText(t).slice(0, 2));
        return hour >= fromHour && hour < toHour;
      });
      if (!inPart.length) return null;
      return h('section.slot-group',
        h('h2.slot-group-title', name),
        h('div.times', inPart.map((t) => h('button.chip', {
          type: 'button',
          'aria-label': `${dayLabel(selected)} בשעה ${timeText(t)}`,
          onclick: () => { d.start = t; d.day = selected; saveDraft(); go('#/book/confirm'); },
        }, ltr(timeText(t))))));
    });
    times.replaceChildren(...groups.filter(Boolean));
  };

  const renderDays = () => {
    strip.replaceChildren(...days.map((k) => h('button.day', {
      type: 'button', 'aria-pressed': String(k === selected),
      class: k === selected ? 'on' : '',
      onclick: () => { selected = k; d.day = k; saveDraft(); renderDays(); renderTimes(); strip.querySelector('.on')?.focus(); },
    }, h('span.day-name', dayLabel(k)), h('span.day-date', shortDate(`${k}T12:00:00Z`)))));
  };
  renderDays();
  renderTimes();

  // גלגלת העכבר בדסקטופ מזיזה את פס הימים לרוחב (כל עוד יש לאן לגלול).
  strip.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const max = strip.scrollWidth - strip.clientWidth;
    if (max <= 0) return;
    const pos = Math.abs(strip.scrollLeft); // ב-RTL הערך שלילי
    if ((e.deltaY > 0 && pos >= max - 1) || (e.deltaY < 0 && pos <= 1)) return;
    e.preventDefault();
    strip.scrollBy({ left: getComputedStyle(strip).direction === 'rtl' ? -e.deltaY : e.deltaY });
  }, { passive: false });

  mount(h('main.page', header('מתי נוח לך?', { back: '#/book' }), summary, strip, times));
  strip.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

export function confirm() {
  const d = draft();
  if (!d.items.length) return go('#/book', { replace: true });
  if (!d.start || new Date(d.start) < new Date()) return go('#/book/time', { replace: true });
  const { duration, price } = draftTotals();
  const start = d.start;
  const today = dateKey(start) === todayKey();
  const btn = h('button.btn.primary.huge', { type: 'button' }, 'אישור וקביעת התור');
  btn.onclick = busy(btn, async () => {
    const { data, error } = await state.sb.rpc('book_appointment', {
      p_business: state.business.id, p_items: d.items, p_start: start,
    });
    if (error) {
      if (/SLOT_TAKEN/.test(error.message)) {
        toast(errorText(error), 'error');
        d.start = null;
        saveDraft();
        return go('#/book/time');
      }
      if (/ALREADY_BOOKED/.test(error.message)) {
        toast(errorText(error));
        resetDraft();
        return goFrom('#/', '#/mine');
      }
      return showError(error);
    }
    state.lastBooked = data;
    resetDraft();
    goFrom('#/', '#/booked');
  });

  mount(h('main.page',
    header('רגע לפני שקובעים', { back: '#/book/time' }),
    h('div.card.stack.confirm',
      row('טיפול', draftText()),
      row('מתי', `${dayLabel(dateKey(start))}, ${longDate(start)}`),
      row('שעה', ltr(timeText(start))),
      row('משך', minutesText(duration)),
      row('מחיר', money(price)),
      state.settings.address ? row('כתובת', state.settings.address) : null),
    h('p.note', today
      ? 'תור להיום אי אפשר לבטל באפליקציה. אם משהו משתנה — צרי קשר.'
      : 'אפשר לבטל באפליקציה עד סוף היום שלפני התור.'),
    btn));
}

const row = (k, v) => h('div.kv', h('span.k', k), h('span.v', v));

export function booked() {
  const a = state.lastBooked;
  if (!a) return go('#/', { replace: true });
  mount(h('main.page.center', { 'data-title': 'התור נקבע' },
    h('div.done-mark', { 'aria-hidden': 'true' }, icon('check')),
    h('h1', 'התור נקבע!'),
    appointmentCard(a),
    // מבטיחים תזכורת רק כשהוואטסאפ באמת מחובר.
    state.cfg?.whatsapp ? h('p.muted.center-text', 'יום לפני התור תגיע אלייך תזכורת בוואטסאפ.') : null,
    h('button.btn.primary', { type: 'button', onclick: () => goBack('#/') }, 'סיום')));
}

// ───────────────────────── התורים שלי ─────────────────────────

export async function mine() {
  mount(h('main.page', header('התורים שלי', { back: '#/' }), h('div.center', spinner())));
  const id = routeId();
  const [{ data: upcoming, error: e1 }, { data: past, error: e2 }] = await Promise.all([
    state.sb.from('appointments').select('*').eq('customer_id', state.profile.id).eq('status', 'booked')
      .gt('end_at', new Date().toISOString()).order('start_at'),
    state.sb.from('appointments').select('*').eq('customer_id', state.profile.id)
      .lte('end_at', new Date().toISOString()).eq('status', 'booked').order('start_at', { ascending: false }).limit(5),
  ]);
  if (id !== routeId()) return;
  if (e1) throw e1;
  if (e2) throw e2;

  const first = state.profile.name.split(' ')[0];
  const active = upcoming.map((a) => {
    const canCancel = todayKey() < dateKey(a.start_at);
    const cancelBtn = h('button.btn.danger', { type: 'button' }, 'ביטול התור');
    cancelBtn.onclick = busy(cancelBtn, async () => {
      if (!window.confirm(`לבטל את התור ${whenText(a.start_at)}?`)) return;
      const { error } = await state.sb.rpc('cancel_appointment', { p_id: a.id });
      if (error) return showError(error);
      toast('התור בוטל');
      await mine();
    });
    return h('div.stack',
      appointmentCard(a),
      canCancel
        ? cancelBtn
        : h('div.stack',
          h('p.note', 'תור להיום אי אפשר לבטל באפליקציה. אם משהו משתנה — צרי קשר.'),
          contactLink(`היי, זו ${first}. יש לי תור היום בשעה ${timeText(a.start_at)} ורציתי לדבר עליו.`)));
  });

  mount(h('main.page',
    header('התורים שלי', { back: '#/' }),
    active.length ? h('section.stack', active) : h('section.stack',
      h('p.lead', 'אין לך תור עתידי.'),
      h('a.btn.primary', { href: '#/book', onclick: startBooking }, 'קבעי תור')),
    past.length ? h('section.stack',
      h('h2', 'תורים קודמים'),
      past.map((a) => h('div.past', h('span', shortDate(a.start_at), ' · ', ltr(timeText(a.start_at))), h('span.muted', itemsText(a.items))))) : null));
}
