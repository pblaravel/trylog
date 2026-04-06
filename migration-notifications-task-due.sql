-- Расширение типа уведомлений: дедлайн задачи (в момент select_date + select_time)
-- Выполнить в SQL Editor после основной migration-notifications.sql

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
    ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('task_reminder', 'task_due', 'overdue_task', 'journal_nudge'));
