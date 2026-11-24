// מעתיק לתיקייה public/vendor את הקבצים החיצוניים שהאפליקציה צריכה בדפדפן,
// כדי שהאתר לא יהיה תלוי באתרים חיצוניים בזמן ריצה.
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('public/vendor', { recursive: true });
copyFileSync('node_modules/@supabase/supabase-js/dist/umd/supabase.js', 'public/vendor/supabase.js');
copyFileSync('node_modules/@fontsource-variable/heebo/files/heebo-hebrew-wght-normal.woff2', 'public/vendor/heebo-hebrew.woff2');
copyFileSync('node_modules/@fontsource-variable/heebo/files/heebo-latin-wght-normal.woff2', 'public/vendor/heebo-latin.woff2');
console.log('vendor: ok');
