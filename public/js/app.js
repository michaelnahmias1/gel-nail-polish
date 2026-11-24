// נקודת הכניסה: טוען הגדרות, מתחבר למסד, ומנתב בין המסכים לפי הכתובת (#/...).
import { h, mount, spinner, toast } from './ui.js';
import * as customer from './customer.js';
import * as owner from './owner.js';

export const state = {
  sb: null,          // חיבור Supabase
  cfg: null,         // הגדרות ציבוריות מהשרת
  business: null,    // {id, name, slug}
  settings: null,    // כללי העסק (כתובת, טלפון, חלון הזמנה...)
  profile: null,     // המשתמשת המחוברת
  services: [],      // המחירון
  draft: null,       // תור בתהליך קביעה: {items: [{service_id, qty}], start}
};

export const isOwner = () => state.profile?.role === 'owner';

export async function loadBusiness() {
  const { data: biz, error } = await state.sb.from('businesses').select('id, name, slug').eq('slug', state.cfg.slug).single();
  if (error) throw error;
  const [{ data: settings, error: e2 }, { data: services, error: e3 }] = await Promise.all([
    state.sb.from('settings').select('*').eq('business_id', biz.id).single(),
    state.sb.from('services').select('*').eq('business_id', biz.id).order('sort_order').order('created_at'),
  ]);
  if (e2) throw e2;
  if (e3) throw e3;
  state.business = biz;
  state.settings = settings;
  state.services = services;
  document.title = biz.name;
}

export async function loadProfile() {
  const { data: { session } } = await state.sb.auth.getSession();
  if (!session) {
    state.profile = null;
    return null;
  }
  const { data, error } = await state.sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if (error) throw error;
  state.profile = data;
  return data;
}

export async function logout() {
  await state.sb.auth.signOut();
  state.profile = null;
  location.hash = '#/login';
}

const routes = [
  [/^\/login$/, customer.login, { public: true }],
  [/^\/name$/, customer.askName],
  [/^\/$/, () => (isOwner() ? owner.calendar() : customer.home())],
  [/^\/book$/, customer.chooseServices],
  [/^\/book\/time$/, customer.chooseTime],
  [/^\/book\/confirm$/, customer.confirm],
  [/^\/booked$/, customer.booked],
  [/^\/mine$/, customer.mine],
  [/^\/setup$/, owner.claim],
  [/^\/owner$/, owner.calendar, { owner: true }],
  [/^\/owner\/new$/, owner.manualBooking, { owner: true }],
  [/^\/owner\/appt\/([\w-]+)$/, owner.appointment, { owner: true }],
  [/^\/owner\/settings$/, owner.settings, { owner: true }],
  [/^\/owner\/settings\/([a-z]+)$/, owner.settingsSection, { owner: true }],
];

async function route() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  const match = routes.find(([re]) => re.test(path));
  if (!match) {
    location.hash = '#/';
    return;
  }
  const [re, view, opts = {}] = match;

  if (!opts.public && !state.profile) {
    location.hash = '#/login';
    return;
  }
  if (state.profile && !state.profile.name && path !== '/name' && !opts.public) {
    location.hash = '#/name';
    return;
  }
  if (opts.owner && !isOwner()) {
    location.hash = '#/';
    return;
  }
  try {
    await view(params, ...(path.match(re).slice(1)));
  } catch (e) {
    console.error(e);
    mount(h('main.page.center',
      h('p.lead', 'לא הצלחנו לטעון את המסך.'),
      h('button.btn.primary', { onclick: () => route() }, 'לנסות שוב')));
  }
}

export const go = (hash) => {
  if (location.hash === hash) route();
  else location.hash = hash;
};

async function boot() {
  mount(h('main.page.center', spinner()));
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('config ' + res.status);
    state.cfg = await res.json();
    state.sb = window.supabase.createClient(state.cfg.supabaseUrl, state.cfg.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'gel-auth' },
    });
    await Promise.all([loadBusiness(), loadProfile()]);
  } catch (e) {
    console.error(e);
    mount(h('main.page.center',
      h('p.lead', 'אין חיבור כרגע.'),
      h('button.btn.primary', { onclick: () => location.reload() }, 'לנסות שוב')));
    return;
  }

  state.sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      state.profile = null;
      if (!location.hash.startsWith('#/login')) location.hash = '#/login';
    }
  });
  window.addEventListener('hashchange', route);
  await route();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('sw', e));
  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data?.type === 'navigate' && ev.data.url) location.hash = ev.data.url.replace(/^\/?/, '').replace(/^#?/, '#');
  });
}
window.addEventListener('offline', () => toast('אין חיבור לאינטרנט', 'error'));

boot();
