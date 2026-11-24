// מסכי הלקוחה: כניסה, שם, בית, קביעת תור (טיפול → יום ושעה → אישור), התורים שלי.
import {
  h, mount, header, spinner, toast, showError, errorText, busy,
  dateKey, timeText, shortDate, longDate, dayLabel, todayKey, addDays,
  money, minutesText, itemsText, waLink, phoneDisplay,
} from './ui.js';
import { state, loadProfile, logout, go, isOwner } from './app.js';

// ───────────────────────── כניסה ─────────────────────────

export function login() {
  if (state.profile) return go('#/');
  let phone = '';

  const phoneInput = h('input.field', {
    type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '050-0000000',
    'aria-label': 'מספר טלפון', maxlength: 15,
  });
  const sendBtn = h('button.btn.primary', { type: 'submit' }, 'שליחת קוד');
  const step1 = h('form.stack', {
    onsubmit: (e) => { e.preventDefault(); start(); },
  },
  h('label.label', { for: 'phone' }, 'מספר הטלפון שלך'),
  Object.assign(phoneInput, { id: 'phone' }),
  sendBtn);

  const start = busy(sendBtn, async () => {
    phone = phoneInput.value.trim();
    if (phone.replace(/\D/g, '').length < 9) return toast('צריך מספר נייד מלא', 'error');
    try {
      const r = await api('start', { phone });
      if (r.status === 'invalid_phone') return toast('המספר לא נראה כמו נייד ישראלי', 'error');
      if (r.status === 'rate_limited') return toast('נשלחו יותר מדי קודים. נסי שוב בעוד רבע שעה.', 'error');
      if (r.status !== 'ok') return toast('לא הצלחנו לשלוח קוד כרגע. נסי שוב מאוחר יותר.', 'error');
      showCodeStep(r);
    } catch (e) {
      showError(e);
    }
  });

  const showCodeStep = (r) => {
    const codeInput = h('input.field.code', {
      id: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
      maxlength: 6, placeholder: '••••••', 'aria-label': 'קוד',
    });
    const enterBtn = h('button.btn.primary', { type: 'submit' }, 'כניסה');
    const finish = busy(enterBtn, async () => {
      const code = codeInput.value.replace(/\D/g, '');
      if (code.length !== 6) return toast('הקוד הוא 6 ספרות', 'error');
      try {
        const res = await api('finish', { phone, code });
        if (res.status !== 'ok') {
          codeInput.select();
          return toast('הקוד לא נכון או שפג תוקפו', 'error');
        }
        const { error } = await state.sb.auth.setSession(res.session);
        if (error) throw error;
        await loadProfile();
        go(state.profile?.name ? '#/' : '#/name');
      } catch (e) {
        showError(e);
      }
    });
    codeInput.addEventListener('input', () => { if (codeInput.value.replace(/\D/g, '').length === 6) finish(); });

    const resend = h('button.link', { type: 'button', disabled: true }, 'שליחה חוזרת');
    let left = 30;
    const tick = setInterval(() => {
      left--;
      resend.textContent = left > 0 ? `שליחה חוזרת (${left})` : 'שליחה חוזרת';
      if (left <= 0) { clearInterval(tick); resend.disabled = false; }
    }, 1000);
    resend.onclick = () => { clearInterval(tick); phoneInput.value = phone; start(); };

    card.replaceChildren(
      h('form.stack', { onsubmit: (e) => { e.preventDefault(); finish(); } },
        h('p.lead', r.channel === 'whatsapp' ? `שלחנו קוד בוואטסאפ ל-${phoneDisplay(phone)}` : `הקוד ל-${phoneDisplay(phone)}`),
        r.demoCode ? h('div.demo', h('strong', 'מצב בדיקה'), ' — הוואטסאפ עוד לא מחובר, אז הקוד מוצג כאן: ',
          h('bdi.demo-code', r.demoCode)) : null,
        codeInput,
        enterBtn,
        h('div.row.spread',
          h('button.link', { type: 'button', onclick: () => location.reload() }, 'מספר אחר'),
          resend)));
    codeInput.focus();
  };

  const card = h('div.card', step1);
  mount(h('main.page.login',
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
  if (state.profile?.name) return go('#/');
  const input = h('input.field', { id: 'name', autocomplete: 'given-name', maxlength: 60, placeholder: 'שם' });
  const btn = h('button.btn.primary', { type: 'submit' }, 'המשך');
  const save = busy(btn, async () => {
    const name = input.value.trim();
    if (!name) return toast('צריך למלא שם', 'error');
    const { data, error } = await state.sb.rpc('set_my_name', { p_name: name });
    if (error) return showError(error);
    state.profile = data;
    go('#/');
  });
  mount(h('main.page.login',
    h('div.card', h('form.stack', { onsubmit: (e) => { e.preventDefault(); save(); } },
      h('label.label', { for: 'name' }, 'איך קוראים לך?'),
      input, btn))));
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

export async function home() {
  mount(h('main.page.center', spinner()));
  const next = await myUpcoming();
  const first = state.profile.name.split(' ')[0];

  mount(h('main.page',
    h('div.hello', h('img.logo.small', { src: '/icons/icon.svg', alt: '' }),
      h('div', h('p.muted', state.business.name), h('h1', `היי ${first}`))),
    next
      ? h('section.stack',
        h('h2', 'התור הקרוב שלך'),
        appointmentCard(next),
        h('a.btn.secondary', { href: '#/mine' }, 'פרטים וביטול'))
      : h('section.stack',
        h('a.btn.primary.huge', { href: '#/book', onclick: () => { state.draft = null; } }, 'קבעי תור')),
    footer()));
}

function footer() {
  const s = state.settings;
  return h('footer.foot',
    s.address ? h('p.muted', '📍 ', s.address) : null,
    s.contact_phone ? h('a.link', { href: waLink(s.contact_phone), target: '_blank', rel: 'noopener' }, 'שאלה? כתבי לנו בוואטסאפ') : null,
    h('a.link', { href: '#/mine' }, 'התורים שלי'),
    h('button.link.muted', { type: 'button', onclick: logout }, 'התנתקות'));
}

function appointmentCard(a) {
  return h('div.card.appt',
    h('div.appt-when', h('strong', `${dayLabel(dateKey(a.start_at))} · ${longDate(a.start_at)}`), h('span.big-time', timeText(a.start_at))),
    h('div.appt-what', itemsText(a.items)),
    h('div.muted', `${minutesText(Math.round((new Date(a.end_at) - new Date(a.start_at)) / 60000))} · ${money(a.total_price)}`));
}

// ───────────────────────── קביעת תור ─────────────────────────

const activeServices = () => state.services.filter((s) => s.active);
const serviceById = (id) => state.services.find((s) => s.id === id);

function draftTotals() {
  let duration = 0;
  let price = 0;
  for (const it of state.draft?.items || []) {
    const s = serviceById(it.service_id);
    if (!s) continue;
    const qty = s.price_type === 'per_unit' ? it.qty || 1 : 1;
    duration += s.duration_min * qty;
    price += s.price * qty;
  }
  return { duration, price };
}

function draftText() {
  return (state.draft?.items || []).map((it) => {
    const s = serviceById(it.service_id);
    return s ? (s.price_type === 'per_unit' && it.qty > 1 ? `${s.name} ×${it.qty}` : s.name) : '';
  }).join(' + ');
}

export async function chooseServices(params) {
  if (!isOwner() && await myUpcoming()) {
    toast('כבר יש לך תור עתידי', 'error');
    return go('#/mine');
  }
  const adding = params.add === '1' && state.draft?.items?.length;
  if (!adding) state.draft = { items: [] };

  const pick = (s, qty) => {
    const items = state.draft.items.filter((i) => i.service_id !== s.id);
    items.push({ service_id: s.id, qty });
    state.draft.items = items;
    go('#/book/time');
  };

  const list = activeServices().map((s) => {
    const already = state.draft.items.some((i) => i.service_id === s.id);
    if (s.price_type === 'per_unit') {
      let qty = 1;
      const count = h('span.qty-n', '1');
      const label = h('span.muted');
      const refresh = () => {
        count.textContent = qty;
        label.textContent = `${minutesText(s.duration_min * qty)} · ${money(s.price * qty)}`;
      };
      refresh();
      const panel = h('div.qty-panel', { hidden: true },
        h('p.muted', 'כמה ציפורניים?'),
        h('div.qty',
          h('button.round', { type: 'button', 'aria-label': 'פחות', onclick: () => { qty = Math.max(1, qty - 1); refresh(); } }, '−'),
          count,
          h('button.round', { type: 'button', 'aria-label': 'יותר', onclick: () => { qty = Math.min(10, qty + 1); refresh(); } }, '+')),
        label,
        h('button.btn.primary', { type: 'button', onclick: () => pick(s, qty) }, 'המשך'));
      return h('div.choice-wrap',
        h('button.choice', { type: 'button', disabled: already, onclick: () => { panel.hidden = !panel.hidden; } },
          h('span.choice-name', s.name),
          h('span.choice-meta', `${money(s.price)} ליחידה`)),
        panel);
    }
    return h('button.choice', { type: 'button', disabled: already, onclick: () => pick(s, 1) },
      h('span.choice-name', s.name),
      h('span.choice-meta', `${minutesText(s.duration_min)} · ${money(s.price)}`));
  });

  mount(h('main.page',
    header(adding ? 'הוספת טיפול' : 'איזה טיפול?', { back: adding ? '#/book/time' : '#/' }),
    adding ? h('p.muted', `כבר בחרת: ${draftText()}`) : null,
    h('div.choices', list.length ? list : h('p.muted', 'אין כרגע טיפולים זמינים.'))));
}

export async function chooseTime() {
  if (!state.draft?.items?.length) return go('#/book');
  mount(h('main.page', header('מתי נוח לך?', { back: '#/book' }), h('div.center', spinner())));

  const from = todayKey();
  const to = addDays(from, state.settings.booking_window_days);
  const { data, error } = await state.sb.rpc('get_free_slots', {
    p_business: state.business.id, p_items: state.draft.items, p_from: from, p_to: to,
  });
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
    h('a.link', { href: '#/book?add=1' }, '+ עוד טיפול'));

  if (!days.length) {
    mount(h('main.page', header('מתי נוח לך?', { back: '#/book' }), summary,
      h('div.card.stack',
        h('p.lead', 'אין שעות פנויות בתקופה הקרובה.'),
        state.settings.contact_phone
          ? h('a.btn.secondary', { href: waLink(state.settings.contact_phone, 'היי, רציתי לקבוע תור'), target: '_blank', rel: 'noopener' }, 'כתבי לנו בוואטסאפ')
          : null)));
    return;
  }

  let selected = state.draft.day && byDay.has(state.draft.day) ? state.draft.day : days[0];
  const strip = h('div.days', { role: 'tablist' });
  const times = h('div.times');

  const render = () => {
    strip.replaceChildren(...days.map((k) => h('button.day', {
      type: 'button', role: 'tab', 'aria-selected': String(k === selected),
      class: k === selected ? 'on' : '',
      onclick: () => { selected = k; state.draft.day = k; render(); },
    }, h('span.day-name', dayLabel(k)), h('span.day-date', shortDate(`${k}T12:00:00Z`)))));
    times.replaceChildren(...byDay.get(selected).map((t) => h('button.chip', {
      type: 'button',
      onclick: () => { state.draft.start = t; state.draft.day = selected; go('#/book/confirm'); },
    }, timeText(t))));
    strip.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  };
  render();

  mount(h('main.page', header('מתי נוח לך?', { back: '#/book' }), summary, strip, times));
}

export function confirm() {
  if (!state.draft?.start) return go('#/book');
  const { duration, price } = draftTotals();
  const start = state.draft.start;
  const btn = h('button.btn.primary.huge', { type: 'button' }, 'אישור וקביעת התור');
  btn.onclick = busy(btn, async () => {
    const { data, error } = await state.sb.rpc('book_appointment', {
      p_business: state.business.id, p_items: state.draft.items, p_start: start,
    });
    if (error) {
      toast(errorText(error), 'error');
      if (/SLOT_TAKEN/.test(error.message)) go('#/book/time');
      if (/ALREADY_BOOKED/.test(error.message)) go('#/mine');
      return;
    }
    state.lastBooked = data;
    state.draft = null;
    go('#/booked');
  });

  mount(h('main.page',
    header('רגע לפני שקובעים', { back: '#/book/time' }),
    h('div.card.stack.confirm',
      row('טיפול', draftText()),
      row('מתי', `${dayLabel(dateKey(start))}, ${longDate(start)}`),
      row('שעה', timeText(start)),
      row('משך', minutesText(duration)),
      row('מחיר', money(price)),
      state.settings.address ? row('כתובת', state.settings.address) : null),
    h('p.note', 'אפשר לבטל באפליקציה עד סוף היום שלפני התור.'),
    btn));
}

const row = (k, v) => h('div.kv', h('span.k', k), h('span.v', v));

export function booked() {
  const a = state.lastBooked;
  if (!a) return go('#/');
  mount(h('main.page.center',
    h('div.done-mark', { 'aria-hidden': 'true' }, '✓'),
    h('h1', 'התור נקבע!'),
    appointmentCard(a),
    h('p.muted.center-text', 'יום לפני התור תגיע אלייך תזכורת.'),
    h('a.btn.primary', { href: '#/' }, 'סיום')));
}

// ───────────────────────── התורים שלי ─────────────────────────

export async function mine() {
  mount(h('main.page', header('התורים שלי', { back: '#/' }), h('div.center', spinner())));
  const [{ data: upcoming, error: e1 }, { data: past, error: e2 }] = await Promise.all([
    state.sb.from('appointments').select('*').eq('customer_id', state.profile.id).eq('status', 'booked')
      .gt('end_at', new Date().toISOString()).order('start_at'),
    state.sb.from('appointments').select('*').eq('customer_id', state.profile.id)
      .lte('end_at', new Date().toISOString()).eq('status', 'booked').order('start_at', { ascending: false }).limit(5),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const active = upcoming.map((a) => {
    const canCancel = todayKey() < dateKey(a.start_at);
    const cancelBtn = h('button.btn.danger', { type: 'button' }, 'ביטול התור');
    cancelBtn.onclick = busy(cancelBtn, async () => {
      if (!window.confirm('לבטל את התור?')) return;
      const { error } = await state.sb.rpc('cancel_appointment', { p_id: a.id });
      if (error) return showError(error);
      toast('התור בוטל');
      mine();
    });
    return h('div.stack',
      appointmentCard(a),
      canCancel
        ? cancelBtn
        : h('div.stack',
          h('p.note', 'ביום התור כבר אי אפשר לבטל באפליקציה.'),
          state.settings.contact_phone
            ? h('a.btn.secondary', { href: waLink(state.settings.contact_phone), target: '_blank', rel: 'noopener' }, 'צרי קשר')
            : null));
  });

  mount(h('main.page',
    header('התורים שלי', { back: '#/' }),
    active.length ? h('section.stack', active) : h('section.stack',
      h('p.lead', 'אין לך תור עתידי.'),
      h('a.btn.primary', { href: '#/book', onclick: () => { state.draft = null; } }, 'קבעי תור')),
    past.length ? h('section.stack',
      h('h2', 'תורים קודמים'),
      past.map((a) => h('div.past', h('span', `${shortDate(a.start_at)} · ${timeText(a.start_at)}`), h('span.muted', itemsText(a.items))))) : null));
}
