-- Раз в 5 минут функция рассылает уведомления о сериях, чьё время выхода уже наступило.
-- Подставить <REF> и <PUBLISH_KEY> перед выполнением (ключ хранится и в RETIKO: config.json → multoretik_bot.publish_key).
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('multoretik-bot-tick', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://<REF>.supabase.co/functions/v1/bot',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{"action":"tick","key":"<PUBLISH_KEY>"}'::jsonb
  );
$$);
