// הגדרות ציבוריות שהאפליקציה בדפדפן צריכה: כתובת המסד, המפתח הציבורי, ומפתח הפוש הציבורי.
import { env, rpc, send, handler } from './_lib.js';

let cache = { at: 0, vapid: null };

export default handler(async (req, res) => {
  if (!cache.vapid || Date.now() - cache.at > 300_000) {
    cache = { at: Date.now(), vapid: await rpc('push_public_key') };
  }
  send(res, 200, {
    supabaseUrl: env.url,
    supabaseKey: env.anon,
    slug: env.slug,
    demoLogin: env.demoLogin,
    vapidPublic: cache.vapid,
  });
});
