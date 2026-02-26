-- ============================================================
-- ThryveLog MVP Notification System — Database Migration
-- Расширяет существующие таблицы: profiles_notifications, notifications
-- ============================================================

-- 1. profiles_notifications: добавляем timezone и last_app_open
ALTER TABLE profiles_notifications
    ADD COLUMN IF NOT EXISTS timezone text DEFAULT 'America/New_York',
    ADD COLUMN IF NOT EXISTS last_app_open timestamptz;

-- 2. notifications: добавляем type, reference_id, title для дедупликации и логики
ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS type text,
    ADD COLUMN IF NOT EXISTS reference_id uuid,
    ADD COLUMN IF NOT EXISTS title text;

-- Ограничение на допустимые типы
ALTER TABLE notifications
    ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('task_reminder', 'overdue_task', 'journal_nudge'));

-- Индексы для быстрой дедупликации
CREATE INDEX IF NOT EXISTS idx_notifications_user_type
    ON notifications(user_id, type);
CREATE INDEX IF NOT EXISTS idx_notifications_user_type_ref
    ON notifications(user_id, type, reference_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at
    ON notifications(created_at);

-- Индекс на fcm_token для фильтрации пользователей с токенами
CREATE INDEX IF NOT EXISTS idx_profiles_notifications_fcm_token
    ON profiles_notifications(id)
    WHERE fcm_token IS NOT NULL;

-- ============================================================
-- pg_cron расписание
-- Раскомментировать и выполнить из Supabase Dashboard → SQL Editor
--
-- service_role key берётся автоматически из supabase_functions.get_secret()
-- (встроенная функция Supabase — ничего настраивать не нужно)
-- ============================================================

-- Напоминания о задачах — каждую минуту
-- SELECT cron.schedule('process-notifications-reminders', '* * * * *',
--   $$SELECT net.http_post(
--     url := 'https://vazeilznifsjxquigwpc.supabase.co/functions/v1/process-notifications',
--     headers := jsonb_build_object(
--       'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
--       'Content-Type', 'application/json'
--     ),
--     body := '{"type": "task_reminders"}'::jsonb
--   )$$
-- );

-- Просроченные задачи — каждые 15 минут
-- SELECT cron.schedule('process-notifications-overdue', '*/15 * * * *',
--   $$SELECT net.http_post(
--     url := 'https://vazeilznifsjxquigwpc.supabase.co/functions/v1/process-notifications',
--     headers := jsonb_build_object(
--       'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
--       'Content-Type', 'application/json'
--     ),
--     body := '{"type": "overdue_tasks"}'::jsonb
--   )$$
-- );

-- Journal nudge — каждый час
-- SELECT cron.schedule('process-notifications-journal', '0 * * * *',
--   $$SELECT net.http_post(
--     url := 'https://vazeilznifsjxquigwpc.supabase.co/functions/v1/process-notifications',
--     headers := jsonb_build_object(
--       'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
--       'Content-Type', 'application/json'
--     ),
--     body := '{"type": "journal_nudge"}'::jsonb
--   )$$
-- );

-- ============================================================
-- Подготовка: сохранить service_role_key в Vault (выполнить ОДИН раз)
-- Dashboard → Settings → API → service_role (secret) → скопировать
-- ============================================================
-- SELECT vault.create_secret(
--   'ВАШ_SERVICE_ROLE_KEY_СЮДА',
--   'service_role_key',
--   'Service role key for cron → Edge Functions'
-- );
