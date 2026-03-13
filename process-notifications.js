import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { JWT } from 'npm:google-auth-library@9';

/**
 * Supabase Edge Function: process-notifications
 *
 * Единая cron-функция для обработки всех типов уведомлений.
 * Вызывается pg_cron с параметром type:
 *   - task_reminders  (каждую минуту)
 *   - overdue_tasks   (каждые 15 минут)
 *   - journal_nudge   (каждый час)
 *
 * POST /functions/v1/process-notifications
 * Authorization: Bearer <service_role_key>
 * Content-Type: application/json
 * { "type": "task_reminders" }
 *
 * Env vars (один из вариантов):
 *   Вариант A: FCM_SERVICE_ACCOUNT — полный JSON Service Account
 *   Вариант B: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 */

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

// ─── Service Account (два формата) ──────────────────────────

function getServiceAccount() {
    const jsonStr = Deno.env.get('FCM_SERVICE_ACCOUNT');
    if (jsonStr?.trim()) {
        try {
            const parsed = JSON.parse(jsonStr.trim());
            if (parsed.project_id && parsed.client_email && parsed.private_key) {
                return {
                    project_id: parsed.project_id,
                    client_email: parsed.client_email,
                    private_key: parsed.private_key,
                };
            }
        } catch { /* fallback to separate vars */ }
    }

    const projectId = Deno.env.get('FIREBASE_PROJECT_ID');
    const clientEmail = Deno.env.get('FIREBASE_CLIENT_EMAIL');
    const privateKey = Deno.env.get('FIREBASE_PRIVATE_KEY');
    if (projectId && clientEmail && privateKey) {
        return { project_id: projectId, client_email: clientEmail, private_key: privateKey };
    }
    return null;
}

// ─── FCM HTTP v1 ────────────────────────────────────────────

function getAccessToken(serviceAccount) {
    const jwtClient = new JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });
    return new Promise((resolve, reject) => {
      jwtClient.authorize((err, tokens) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(tokens.access_token);
      });
    });
  }

async function sendFcm(accessToken, projectId, fcmToken, title, body) {
    if (!accessToken || typeof accessToken !== 'string') {
        console.error('sendFcm: accessToken is empty or invalid');
        return { ok: false, invalidToken: false };
    }

    const message = {
        message: {
            token: fcmToken,
            notification: { title, body },
            apns: {
                payload: { aps: { sound: 'default' } },
            },
        },
    };

    const resp = await fetch(
        `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(message),
        },
    );

    if (!resp.ok) {
        const err = await resp.text();
        console.error(`FCM send error (token=${fcmToken.slice(0, 10)}...): ${err}`);
        const invalidToken = resp.status === 401 || resp.status === 404 ||
            (resp.status === 400 && err.includes('INVALID_ARGUMENT'));
        if (invalidToken) {
            console.error(`FCM ${resp.status}: Invalid/expired token — clearing fcm_token for user`);
        }
        return { ok: false, invalidToken };
    }
    return { ok: true };
}

async function sendToUser(accessToken, projectId, fcmToken, title, body, userId, supabase) {
    if (!fcmToken) return false;
    try {
        const result = await sendFcm(accessToken, projectId, fcmToken, title, body);
        if (result.invalidToken && userId && supabase) {
            const { error } = await supabase
                .from('profiles_notifications')
                .update({ fcm_token: null })
                .eq('id', userId);
            if (error) {
                console.error(`Failed to clear invalid token for user ${userId}:`, error.message);
            } else {
                console.log(`Cleared invalid fcm_token for user ${userId}`);
            }
        }
        return result.ok;
    } catch (err) {
        console.error('sendToUser error:', err.message);
        return false;
    }
}

// ─── helpers ────────────────────────────────────────────────

const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

const MAX_BODY_LENGTH = 100;
const trimText = (text) =>
    text.length > MAX_BODY_LENGTH ? text.slice(0, MAX_BODY_LENGTH - 1) + '…' : text;

const HOURS_72 = 72 * 60 * 60 * 1000;
const HOURS_24 = 24 * 60 * 60 * 1000;

const REMINDER_OFFSETS_MINUTES = {
    fiveMinutes: 5,
    tenMinutes: 10,
    fifteenMinutes: 15,
    thirtyMinutes: 30,
    oneHour: 60,
    oneDay: 1440,
};

const OVERDUE_TITLES = [
    'Still doing this today?',
    'Quick reminder:',
    'Want to reschedule it?',
    'Still on your list today?',
    'Keep it or move it?',
];

const NUDGE_COPIES = [
    'No pressure — quick check-in?',
    'One line is enough today.',
    'Want to capture a quick thought?',
    'Got something on your mind?',
    'Take couple minutes to reflect.',
];

function getUserLocalHour(utcDate, timezone) {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone, hour: 'numeric', minute: 'numeric', hour12: false,
        }).formatToParts(utcDate);
        return {
            hour: parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10),
            minute: parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10),
        };
    } catch {
        return { hour: utcDate.getUTCHours(), minute: utcDate.getUTCMinutes() };
    }
}

/** Парсит date+time в timezone пользователя и возвращает UTC Date */
function parseTaskDateTimeInTimezone(selectDate, selectTime, timezone) {
    const timeStr = String(selectTime).length === 5 ? `${selectTime}:00` : selectTime;
    const tempUtc = new Date(`${selectDate}T${timeStr}Z`);
    const noonUtc = new Date(`${selectDate}T12:00:00Z`);
    try {
        const hourParts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone, hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
        }).formatToParts(noonUtc);
        const h = parseInt(hourParts.find((p) => p.type === 'hour')?.value ?? '12', 10);
        const offsetHours = h - 12;
        return new Date(tempUtc.getTime() - offsetHours * 60 * 60 * 1000);
    } catch {
        return tempUtc;
    }
}

function getUserLocalDateStr(utcDate, timezone) {
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(utcDate);
    } catch {
        return utcDate.toISOString().split('T')[0];
    }
}

async function logNotification(supabase, userId, type, referenceId, title, body) {
    const { error } = await supabase.from('notifications').insert({
        user_id: userId,
        type,
        reference_id: referenceId,
        title,
        body,
    });
    if (error) console.error('Error logging notification:', error.message);
}

// ─── Processors ─────────────────────────────────────────────

async function processTaskReminders(supabase, accessToken, projectId) {
    const now = new Date();
    const windowStart = new Date(now.getTime() - 180_000);
    const windowEnd = new Date(now.getTime() + 60_000);
    console.log(`[reminders] now=${now.toISOString()} window=[${windowStart.toISOString()} .. ${windowEnd.toISOString()}]`);

    const { data: tasks, error } = await supabase
        .from('tasks')
        .select('id, user_id, title, select_date, select_time, reminder')
        .eq('is_completed', false)
        .neq('reminder', 'noReminders')
        .not('select_date', 'is', null)
        .not('select_time', 'is', null);

    if (error) { console.error('Tasks fetch error:', error.message); return 0; }
    if (!tasks?.length) return 0;
    console.log(`[reminders] fetched ${tasks.length} tasks with reminder`);

    let sent = 0;
    for (const task of tasks) {
        const offset = REMINDER_OFFSETS_MINUTES[task.reminder];
        if (!offset) continue;

        const { data: profile } = await supabase
            .from('profiles_notifications')
            .select('fcm_token, timezone')
            .eq('id', task.user_id)
            .maybeSingle();
        if (!profile?.fcm_token) continue;

        const tz = profile.timezone || 'UTC';
        const taskDt = parseTaskDateTimeInTimezone(task.select_date, task.select_time, tz);
        const reminderTime = new Date(taskDt.getTime() - offset * 60_000);
        if (reminderTime < windowStart || reminderTime > windowEnd) {
            if (Math.abs(reminderTime - now) < 10 * 60_000) {
                console.log(`[reminders] task=${task.id} skip: outside window tz=${tz} taskDt=${taskDt.toISOString()} reminderTime=${reminderTime.toISOString()}`);
            }
            continue;
        }

        const { data: existing } = await supabase
            .from('notifications')
            .select('id')
            .eq('user_id', task.user_id)
            .eq('type', 'task_reminder')
            .eq('reference_id', task.id)
            .limit(1)
            .maybeSingle();
        if (existing) continue;

        const title = '⏰ Reminder';
        const body = trimText(task.title);

        const ok = await sendToUser(accessToken, projectId, profile.fcm_token, title, body, task.user_id, supabase);
        if (ok) {
            await logNotification(supabase, task.user_id, 'task_reminder', task.id, title, body);
            sent++;
            console.log(`Task reminder sent: task=${task.id}`);
        }
    }
    return sent;
}

async function processOverdueTasks(supabase, accessToken, projectId) {
    const now = new Date();
    console.log(`[overdue] now=${now.toISOString()}`);

    const { data: tasks, error } = await supabase
        .from('tasks')
        .select('id, user_id, title, select_date, select_time')
        .eq('is_completed', false)
        .not('select_date', 'is', null)
        .not('select_time', 'is', null);

    if (error) { console.error('Tasks fetch error:', error.message); return 0; }
    if (!tasks?.length) return 0;
    console.log(`[overdue] fetched ${tasks.length} incomplete tasks`);

    let sent = 0;
    for (const task of tasks) {
        const { data: profile } = await supabase
            .from('profiles_notifications')
            .select('fcm_token, timezone')
            .eq('id', task.user_id)
            .maybeSingle();
        if (!profile?.fcm_token) continue;

        const tz = profile.timezone || 'UTC';
        const taskDt = parseTaskDateTimeInTimezone(task.select_date, task.select_time, tz);
        const overdueTime = new Date(taskDt.getTime() + 60 * 60_000);
        const diff = now.getTime() - overdueTime.getTime();
        if (diff < 0 || diff > HOURS_24) continue;

        const { data: existing } = await supabase
            .from('notifications')
            .select('id')
            .eq('user_id', task.user_id)
            .eq('type', 'overdue_task')
            .eq('reference_id', task.id)
            .limit(1)
            .maybeSingle();
        if (existing) continue;

        const title = pickRandom(OVERDUE_TITLES);
        const body = trimText(task.title);

        const ok = await sendToUser(accessToken, projectId, profile.fcm_token, title, body, task.user_id, supabase);
        if (ok) {
            await logNotification(supabase, task.user_id, 'overdue_task', task.id, title, body);
            sent++;
            console.log(`Overdue notification sent: task=${task.id}`);
        }
    }
    return sent;
}

async function processJournalNudge(supabase, accessToken, projectId) {
    const now = new Date();

    const { data: profiles, error } = await supabase
        .from('profiles_notifications')
        .select('id, fcm_token, timezone, last_app_open')
        .not('fcm_token', 'is', null);

    if (error) { console.error('Profiles fetch error:', error.message); return 0; }
    if (!profiles?.length) return 0;

    let sent = 0;
    for (const profile of profiles) {
        try {
            const tz = profile.timezone || 'America/New_York';

            // 18:00–20:30 по локальному времени
            const { hour, minute } = getUserLocalHour(now, tz);
            const localMinutes = hour * 60 + minute;
            if (localMinutes < 1080 || localMinutes > 1230) continue; // 18*60=1080, 20*60+30=1230

            // Подавление: пользователь открывал приложение за 24ч
            if (profile.last_app_open) {
                const lastOpen = new Date(profile.last_app_open);
                if (now.getTime() - lastOpen.getTime() < HOURS_24) continue;
            }

            // Последняя запись в дневнике >72ч?
            const { data: lastJournal } = await supabase
                .from('journal')
                .select('created_at')
                .eq('user_id', profile.id)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (lastJournal) {
                if (now.getTime() - new Date(lastJournal.created_at).getTime() < HOURS_72) continue;
            }

            // Макс 1 nudge за 72 часа
            const cutoff72 = new Date(now.getTime() - HOURS_72);
            const { data: recentNudge } = await supabase
                .from('notifications')
                .select('id')
                .eq('user_id', profile.id)
                .eq('type', 'journal_nudge')
                .gte('created_at', cutoff72.toISOString())
                .limit(1)
                .maybeSingle();
            if (recentNudge) continue;

            // Подавление: planner-уведомления сегодня
            const todayStr = getUserLocalDateStr(now, tz);
            const { data: plannerToday } = await supabase
                .from('notifications')
                .select('id')
                .eq('user_id', profile.id)
                .in('type', ['task_reminder', 'overdue_task'])
                .gte('created_at', `${todayStr}T00:00:00Z`)
                .limit(1)
                .maybeSingle();
            if (plannerToday) continue;

            const nudgeText = pickRandom(NUDGE_COPIES);

            const ok = await sendToUser(accessToken, projectId, profile.fcm_token, nudgeText, '', profile.id, supabase);
            if (ok) {
                await logNotification(supabase, profile.id, 'journal_nudge', null, nudgeText, '');
                sent++;
                console.log(`Journal nudge sent: user=${profile.id}`);
            }
        } catch (err) {
            console.error(`Error processing user ${profile.id}:`, err.message);
        }
    }
    return sent;
}

// ─── Main handler ───────────────────────────────────────────

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
        let type = null;
        if (req.method === 'POST') {
            try {
                const body = await req.json();
                type = body.type ?? null;
            } catch { /* пустой body — ок */ }
        } else {
            type = new URL(req.url).searchParams.get('type');
        }

        const validTypes = ['task_reminders', 'overdue_tasks', 'journal_nudge'];
        if (!type || !validTypes.includes(type)) {
            return json({
                success: false,
                error: `type is required: ${validTypes.join(', ')}`,
            }, 400);
        }

        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
            { auth: { persistSession: false, autoRefreshToken: false } },
        );

        const serviceAccount = getServiceAccount();
        if (!serviceAccount) {
            return json({
                success: false,
                error: 'Configure FCM_SERVICE_ACCOUNT (full JSON) OR FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY',
            }, 500);
        }

        const projectId = serviceAccount.project_id;
        const accessToken = await getAccessToken(serviceAccount);

        let processed = 0;

        if (type === 'task_reminders') {
            processed = await processTaskReminders(supabase, accessToken, projectId);
        } else if (type === 'overdue_tasks') {
            processed = await processOverdueTasks(supabase, accessToken, projectId);
        } else if (type === 'journal_nudge') {
            processed = await processJournalNudge(supabase, accessToken, projectId);
        }

        console.log(`[${type}] Done. Sent: ${processed}`);
        return json({ success: true, type, processed });

    } catch (error) {
        console.error('Error:', error);
        return json({ success: false, error: error.message }, 500);
    }
});
