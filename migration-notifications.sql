-- ============================================================
-- ThryveLog MVP Notification System — Database Migration
-- ============================================================

-- 1. Push-токены устройств пользователей (APNs / FCM / Expo)
CREATE TABLE IF NOT EXISTS push_tokens (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token       text NOT NULL,
    platform    text NOT NULL DEFAULT 'ios'
                    CHECK (platform IN ('ios', 'android')),
    created_at  timestamptz DEFAULT now(),
    updated_at  timestamptz DEFAULT now(),
    UNIQUE (user_id, token)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id ON push_tokens(user_id);

ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY push_tokens_select ON push_tokens
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY push_tokens_insert ON push_tokens
    FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY push_tokens_delete ON push_tokens
    FOR DELETE USING (auth.uid() = user_id);

-- 2. Лог отправленных уведомлений (дедупликация + аналитика)
CREATE TABLE IF NOT EXISTS notification_log (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type          text NOT NULL
                      CHECK (type IN ('task_reminder', 'overdue_task', 'journal_nudge')),
    reference_id  uuid,          -- task_id для task-уведомлений, NULL для journal nudge
    title         text NOT NULL,
    body          text NOT NULL,
    sent_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_log_user_type
    ON notification_log(user_id, type);
CREATE INDEX IF NOT EXISTS idx_notification_log_reference
    ON notification_log(user_id, type, reference_id);
CREATE INDEX IF NOT EXISTS idx_notification_log_sent_at
    ON notification_log(sent_at);

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_log_select ON notification_log
    FOR SELECT USING (auth.uid() = user_id);

-- 3. Состояние уведомлений пользователя (таймзона, последнее открытие приложения)
CREATE TABLE IF NOT EXISTS notification_state (
    id                     uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id                uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
    timezone               text DEFAULT 'America/New_York',
    last_app_open          timestamptz,
    notifications_enabled  boolean DEFAULT true,
    created_at             timestamptz DEFAULT now(),
    updated_at             timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_state_user_id
    ON notification_state(user_id);

ALTER TABLE notification_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_state_select ON notification_state
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY notification_state_insert ON notification_state
    FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY notification_state_update ON notification_state
    FOR UPDATE USING (auth.uid() = user_id);

-- ============================================================
-- pg_cron расписание (выполнять из Supabase Dashboard → SQL Editor)
-- ============================================================
-- Напоминания о задачах — каждую минуту
-- SELECT cron.schedule('process-task-reminders', '* * * * *',
--   $$SELECT net.http_post(
--     url := 'https://vazeilznifsjxquigwpc.supabase.co/functions/v1/process-task-reminders',
--     headers := jsonb_build_object(
--       'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
--       'Content-Type', 'application/json'
--     ),
--     body := '{}'::jsonb
--   )$$
-- );
--
-- Просроченные задачи — каждые 15 минут
-- SELECT cron.schedule('process-overdue-tasks', '*/15 * * * *',
--   $$SELECT net.http_post(
--     url := 'https://vazeilznifsjxquigwpc.supabase.co/functions/v1/process-overdue-tasks',
--     headers := jsonb_build_object(
--       'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
--       'Content-Type', 'application/json'
--     ),
--     body := '{}'::jsonb
--   )$$
-- );
--
-- Journal nudge — каждый час
-- SELECT cron.schedule('process-journal-nudge', '0 * * * *',
--   $$SELECT net.http_post(
--     url := 'https://vazeilznifsjxquigwpc.supabase.co/functions/v1/process-journal-nudge',
--     headers := jsonb_build_object(
--       'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
--       'Content-Type', 'application/json'
--     ),
--     body := '{}'::jsonb
--   )$$
-- );
