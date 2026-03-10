# Настройка системы нотификаций ThryveLog MVP

Система нотификаций реализована по [спецификации MVP](docs/ThryveLog_MVP_Notification_Specification.pdf).

## Что уже сделано

- ✅ Edge Functions задеплоены: `process-notifications`, `update-notification-state`
- ✅ Таблицы `profiles_notifications` и `notifications` настроены
- ✅ pg_cron и pg_net включены
- ✅ Cron jobs созданы (reminders каждую минуту, overdue каждые 15 мин, journal nudge каждый час)

## Что нужно настроить вручную

### 1. Firebase Cloud Messaging (FCM)

1. В [Firebase Console](https://console.firebase.google.com/) создайте проект (или используйте существующий)
2. Добавьте iOS-приложение и включите Cloud Messaging
3. Скачайте **Service Account Key** (JSON): Project Settings → Service accounts → Generate new private key
4. Запомните **Project ID** из Firebase Console

### 2. Secrets для Edge Function `process-notifications`

В Supabase Dashboard: **Edge Functions** → **process-notifications** → **Secrets**

Добавьте переменные:

| Имя | Значение |
|-----|----------|
| `FCM_PROJECT_ID` | ID проекта Firebase (например `my-app-12345`) |
| `FCM_SERVICE_ACCOUNT` | Полное содержимое JSON-файла Service Account (одна строка) |

### 3. Service Role Key для Cron

Cron вызывает Edge Function с авторизацией. Нужно сохранить Service Role Key в Vault:

**Вариант A — через Dashboard:**

1. **Project Settings** → **Vault** → **New Secret**
2. Name: `notification_service_role_key`
3. Secret: вставьте **Service Role Key** (Settings → API → service_role key)

**Вариант B — через SQL Editor:**

```sql
SELECT vault.create_secret(
  'ВАШ_SERVICE_ROLE_KEY_СЮДА',
  'notification_service_role_key',
  'Service role key for cron to call process-notifications'
);
```

### 4. iOS-клиент

Приложение должно:

1. **Запрашивать разрешение** на push-уведомления
2. **При открытии** вызывать `update-notification-state` с `last_app_open: true`
3. **При смене timezone** передавать `timezone`
4. **При получении FCM токена** передавать `fcm_token`

Пример вызова:

```swift
// При открытии приложения
await supabase.functions.invoke("update-notification-state", options: .init(
  body: ["last_app_open": true, "timezone": TimeZone.current.identifier]
))

// При регистрации FCM токена
await supabase.functions.invoke("update-notification-state", options: .init(
  body: ["fcm_token": deviceToken]
))
```

## Типы уведомлений

| Тип | Триггер | Расписание |
|-----|---------|------------|
| **Task Reminder** | Время напоминания задачи | Каждую минуту |
| **Overdue Task** | +1 час после дедлайна | Каждые 15 минут |
| **Journal Nudge** | 72ч без записей в дневнике | 18:00–20:30 по локальному времени, каждый час |

## Проверка

Ручной вызов для теста:

```bash
curl -X POST "https://vazeilznifsjxquigwpc.supabase.co/functions/v1/process-notifications" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "task_reminders"}'
```

Логи: **Edge Functions** → **process-notifications** → **Logs**

## Cron

Мониторинг: **Integrations** → **Cron** в Supabase Dashboard
