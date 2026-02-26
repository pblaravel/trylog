import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

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
 * Env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   FCM_PROJECT_ID        — Firebase project ID
 *   FCM_SERVICE_ACCOUNT   — JSON service account key (строка)
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

// ─── FCM HTTP v1 ────────────────────────────────────────────

function base64url(data) {
    const base64 = btoa(data);
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlEncode(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return base64url(binary);
}

async function getAccessToken(serviceAccount) {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({
        iss: serviceAccount.client_email,
        sub: serviceAccount.client_email,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
    }));

    const signingInput = `${header}.${payload}`;
    const pemBody = serviceAccount.private_key
        .replace(/-----BEGIN PRIVATE KEY-----/, '')
        .replace(/-----END PRIVATE KEY-----/, '')
        .replace(/\n/g, '');
    const binaryDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
        'pkcs8', binaryDer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
    );
    const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput),
    );

    const jwt = `${signingInput}.${base64urlEncode(signature)}`;

    const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });

    const data = await resp.json();
    if (!data.access_token) throw new Error(`FCM auth failed: ${JSON.stringify(data)}`);
    return data.access_token;
}

async function sendFcm(accessToken, projectId, fcmToken, title, body) {
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
        return false;
    }
    return true;
}

async function sendToUser(accessToken, projectId, fcmToken, title, body) {
    if (!fcmToken) return false;
    try {
        return await sendFcm(accessToken, projectId, fcmToken, title, body);
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
    const windowStart = new Date(now.getTime() - 90_000);
    const windowEnd = new Date(now.getTime() + 30_000);

    const { data: tasks, error } = await supabase
        .from('tasks')
        .select('id, user_id, title, select_date, select_time, reminder')
        .eq('is_completed', false)
        .neq('reminder', 'noReminders')
        .not('select_date', 'is', null)
        .not('select_time', 'is', null);

    if (error) { console.error('Tasks fetch error:', error.message); return 0; }
    if (!tasks?.length) return 0;

    let sent = 0;
    for (const task of tasks) {
        const offset = REMINDER_OFFSETS_MINUTES[task.reminder];
        if (!offset) continue;

        const taskDt = new Date(`${task.select_date}T${task.select_time}Z`);
        const reminderTime = new Date(taskDt.getTime() - offset * 60_000);
        if (reminderTime < windowStart || reminderTime > windowEnd) continue;

        const { data: existing } = await supabase
            .from('notifications')
            .select('id')
            .eq('user_id', task.user_id)
            .eq('type', 'task_reminder')
            .eq('reference_id', task.id)
            .limit(1)
            .maybeSingle();
        if (existing) continue;

        const { data: profile } = await supabase
            .from('profiles_notifications')
            .select('fcm_token')
            .eq('id', task.user_id)
            .maybeSingle();
        if (!profile?.fcm_token) continue;

        const title = '⏰ Reminder';
        const body = trimText(task.title);

        const ok = await sendToUser(accessToken, projectId, profile.fcm_token, title, body);
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

    const { data: tasks, error } = await supabase
        .from('tasks')
        .select('id, user_id, title, select_date, select_time')
        .eq('is_completed', false)
        .not('select_date', 'is', null)
        .not('select_time', 'is', null);

    if (error) { console.error('Tasks fetch error:', error.message); return 0; }
    if (!tasks?.length) return 0;

    let sent = 0;
    for (const task of tasks) {
        const taskDt = new Date(`${task.select_date}T${task.select_time}Z`);
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

        const { data: profile } = await supabase
            .from('profiles_notifications')
            .select('fcm_token')
            .eq('id', task.user_id)
            .maybeSingle();
        if (!profile?.fcm_token) continue;

        const title = pickRandom(OVERDUE_TITLES);
        const body = trimText(task.title);

        const ok = await sendToUser(accessToken, projectId, profile.fcm_token, title, body);
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

            const ok = await sendToUser(accessToken, projectId, profile.fcm_token, nudgeText, '');
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

        const fcmAccountJson = Deno.env.get('FCM_SERVICE_ACCOUNT');
        const fcmProjectId = Deno.env.get('FCM_PROJECT_ID');
        if (!fcmAccountJson || !fcmProjectId) {
            return json({ success: false, error: 'FCM_SERVICE_ACCOUNT or FCM_PROJECT_ID not configured' }, 500);
        }

        const serviceAccount = JSON.parse(fcmAccountJson);
        const accessToken = await getAccessToken(serviceAccount);

        let processed = 0;

        if (type === 'task_reminders') {
            processed = await processTaskReminders(supabase, accessToken, fcmProjectId);
        } else if (type === 'overdue_tasks') {
            processed = await processOverdueTasks(supabase, accessToken, fcmProjectId);
        } else if (type === 'journal_nudge') {
            processed = await processJournalNudge(supabase, accessToken, fcmProjectId);
        }

        console.log(`[${type}] Done. Sent: ${processed}`);
        return json({ success: true, type, processed });

    } catch (error) {
        console.error('Error:', error);
        return json({ success: false, error: error.message }, 500);
    }
});
