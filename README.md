# Мої ліки

Міні-додаток для щоденного відмічання ліків і щотижневого уколу з нагадуваннями в Telegram.

- **Додаток:** статичний PWA (`index.html`, `app.js`, `style.css`) на GitHub Pages. Можна додати на головний екран телефона.
- **Дані:** Supabase (проєкт `moi-liky`), таблиці `meds`, `intakes`, `settings`. Доступ захищено RLS, і реєстрація дозволена лише для власниці.
- **Бот:** Supabase Edge Function `tg-bot` (`supabase/functions/tg-bot`). `pg_cron` викликає її щохвилини: вона надсилає нагадування за 5 хв до прийому і повтор через 15 хв, якщо прийом не відмічено. Кнопки в повідомленнях записують відмітку одразу в базу.

## Увімкнути GitHub Pages
Settings → Pages → Source: *Deploy from a branch* → Branch: `main` / root → Save.
Адреса: https://doragolum.github.io/moi-liky/
