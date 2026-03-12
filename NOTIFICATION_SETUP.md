# Настройка системы нотификаций ThryveLog MVP

Система нотификаций реализована по спецификации MVP.

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

**Вариант A** — один JSON (рекомендуется):

| Имя | Значение |
|-----|----------|
| `FCM_SERVICE_ACCOUNT` | **Полное содержимое** JSON-файла Service Account. Откройте файл, скопируйте всё (начинается с `{"type":"service_account",...}`). |

**Вариант B** — отдельные переменные (если JSON вызывает проблемы):

| Имя | Значение |
|-----|----------|
| `FIREBASE_PROJECT_ID` | ID проекта (например `thryvelog-inc`) |
| `FIREBASE_CLIENT_EMAIL` | `client_email` из JSON (например `firebase-adminsdk-xxx@project.iam.gserviceaccount.com`) |
| `FIREBASE_PRIVATE_KEY` | `private_key` из JSON. **Важно:** если 401 сохраняется, попробуйте вставить ключ в одну строку, заменив переносы на `\n` (два символа: обратный слэш + n). Пример: `-----BEGIN PRIVATE KEY-----\nMIIEvg...\n-----END PRIVATE KEY-----\n` |

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

## Важно: APNS для iOS

Ошибка **401 THIRD_PARTY_AUTH_ERROR** часто связана с **APNS (Apple Push)**, а не с OAuth.

Для iOS push нужно настроить APNS в Firebase:

1. **Firebase Console** → **Project settings** → **Cloud Messaging**
2. В разделе **Apple app configuration** загрузите **APNs Authentication Key** (.p8)
3. Укажите **Key ID**, **Team ID** (без пробелов, uppercase)
4. Bundle ID должен совпадать с приложением

Без APNS ключа push на iOS не будут работать.

---

## Проверка

Ручной вызов для теста:

```bash
curl -X POST "https://vazeilznifsjxquigwpc.supabase.co/functions/v1/process-notifications" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "task_reminders"}'
```

Логи: **Edge Functions** → **process-notifications** → **Logs**

В логах при каждом запуске:
- `[reminders] now=... window=[...]` — текущее время и окно поиска
- `[reminders] fetched N tasks` — сколько задач с напоминаниями
- `[reminders] task=X skip: outside window` — задача пропущена (вне окна, проверьте timezone)
- `Task reminder sent: task=X` — уведомление отправлено

**Важно:** `select_date` и `select_time` интерпретируются в **локальном времени пользователя**. Убедитесь, что клиент передаёт `timezone` в `update-notification-state` при открытии приложения.

## Cron

Мониторинг: **Integrations** → **Cron** в Supabase Dashboard
