// אייקונים בקו אחיד (רשת 24, קו 2, צבע לפי הטקסט): icon('settings') או icon('close', {label: 'סגירה'}).
// בלי תווית — האייקון מוסתר מקוראי מסך; עם תווית — מוקרא כתמונה בשם הזה.

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  // גלגל שיניים
  settings: [
    ['path', { d: 'M18.69 9.93L21.31 10.11L21.31 13.89L18.69 14.07A7 7 0 0 1 18.19 15.27L19.92 17.25L17.25 19.92L15.27 18.19A7 7 0 0 1 14.07 18.69L13.89 21.31L10.11 21.31L9.93 18.69A7 7 0 0 1 8.73 18.19L6.75 19.92L4.08 17.25L5.81 15.27A7 7 0 0 1 5.31 14.07L2.69 13.89L2.69 10.11L5.31 9.93A7 7 0 0 1 5.81 8.73L4.08 6.75L6.75 4.08L8.73 5.81A7 7 0 0 1 9.93 5.31L10.11 2.69L13.89 2.69L14.07 5.31A7 7 0 0 1 15.27 5.81L17.25 4.08L19.92 6.75L18.19 8.73A7 7 0 0 1 18.69 9.93Z' }],
    ['circle', { cx: 12, cy: 12, r: 3 }],
  ],
  // סיכת מיקום
  location: [
    ['path', { d: 'M19 10c0 5-7 12-7 12s-7-7-7-12a7 7 0 0 1 14 0z' }],
    ['circle', { cx: 12, cy: 10, r: 2.5 }],
  ],
  // עיגול עם קו — זמן חסום
  block: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M5.64 5.64l12.72 12.72' }],
  ],
  close: [['path', { d: 'M18 6L6 18M6 6l12 12' }]],
  check: [['path', { d: 'M20 6L9 17l-5-5' }]],
  up: [['path', { d: 'M6 15l6-6 6 6' }]],
  down: [['path', { d: 'M6 9l6 6 6-6' }]],
  // «חזרה» באפליקציה מימין לשמאל — החץ מצביע ימינה (→)
  back: [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  // שפופרת טלפון
  phone: [
    ['path', { d: 'M5 3.5h3.2l1.8 4.6-2.3 1.4a11 11 0 0 0 6.8 6.8l1.4-2.3 4.6 1.8V19a1.5 1.5 0 0 1-1.6 1.5A16 16 0 0 1 3.5 5.1 1.5 1.5 0 0 1 5 3.5z' }],
  ],
  // בועת שיחה עם שפופרת קטנה (קו בלבד, לא הלוגו)
  whatsapp: [
    ['path', { d: 'M3.5 20.5l1.3-4.3a9 9 0 1 1 3.2 3.1z' }],
    ['path', { 'stroke-width': 1.5, d: 'M9.2 8h1.3l.8 2-.9.6a4.6 4.6 0 0 0 3 3l.6-.9 2 .8v1.3a.8.8 0 0 1-.9.8A6.6 6.6 0 0 1 8.4 8.9a.8.8 0 0 1 .8-.9z' }],
  ],
  calendar: [
    ['rect', { x: 3, y: 4.5, width: 18, height: 16.5, rx: 2 }],
    ['path', { d: 'M8 2.5v4M16 2.5v4M3 10h18' }],
  ],
  clock: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M12 7v5l3.5 2' }],
  ],
  // חץ מעגלי — רענון
  refresh: [
    ['path', { d: 'M20 12a8 8 0 1 1-2.34-5.66L20 8.5' }],
    ['path', { d: 'M20 3.5v5h-5' }],
  ],
};

export const ICON_NAMES = Object.keys(ICONS);

export function icon(name, { label } = {}) {
  // שם לא מוכר: אייקון ריק, ולא קריסה של המסך כולו.
  const parts = ICONS[name] || [];
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = {
    viewBox: '0 0 24 24',
    class: 'icon',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    focusable: 'false',
  };
  if (label) {
    attrs.role = 'img';
    attrs['aria-label'] = label;
  } else {
    attrs['aria-hidden'] = 'true';
  }
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const [tag, props] of parts) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(props)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}
