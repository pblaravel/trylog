import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * Supabase Edge Function: process-journal-nudge
 *
 * Вызывается по cron (каждый час).
 * Отправляет nudge-уведомления пользователям, которые не писали в дневник 72+ часов.
 *
 * Логика (из спецификации):
 * - Триггер: нет записи в дневнике 72 часа (3 дня)
 * - Время: только между 18:00 и 20:30 по локальному времени пользователя
 * - Случайная минута внутри окна
 * - Макс 1 nudge за 72 часа
 * - Подавляется на 24ч, если сегодня было Planner-уведомление (task_reminder или overdue_task)
 * - Подавляется на 24ч, если пользователь открывал приложение
 * - Сбрасывается при любой новой записи в дневнике
 *
 * Copy варианты:
 *   No pressure — quick check-in? / One line is enough today. /
 *   Want to capture a quick thought? / Got something on your mind? /
 *   Take couple minutes to reflect.
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

const NUDGE_COPIES = [
    'No pressure — quick check-in?',
    'One line is enough today.',
    'Want to capture a quick thought?',
    'Got something on your mind?',
    'Take couple minutes to reflect.',
];

const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

const HOURS_72 = 72 * 60 * 60 * 1000;
const HOURS_24 = 24 * 60 * 60 * 1000;

function getUserLocalHour(utcDate, timezone) {
    try {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hour: 'numeric',
            minute: 'numeric',
            hour12: false,
        });
        const parts = formatter.formatToParts(utcDate);
        const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
        const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
        return { hour, minute };
    } catch {
        return { hour: new Date().getUTCHours(), minute: new Date().getUTCMinutes() };
    }
}

function getUserLocalDateStr(utcDate, timezone) {
    try {
        const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        return formatter.format(utcDate);
    } catch {
        return utcDate.toISOString().split('T')[0];
    }
}

async function sendExpoPush(tokens, title, body) {
    if (!tokens.length) return [];

    const messages = tokens.map((t) => ({
        to: t,
        sound: 'default',
        title,
        body,
    }));

    const chunks = [];
    for (let i = 0; i < messages.length; i += 100) {
        chunks.push(messages.slice(i, i + 100));
    }

    const results = [];
    for (const chunk of chunks) {
        try {
            const resp = await fetch('https://exp.host/--/api/v2/push/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(chunk),
            });
            const data = await resp.json();
            results.push(data);
        } catch (err) {
            console.error('Expo push error:', err.message);
        }
    }
    return results;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
            { auth: { persistSession: false, autoRefreshToken: false } },
        );

        const now = new Date();

        // Получаем всех пользователей с push-токенами и включёнными уведомлениями
        const { data: usersWithTokens, error: usersError } = await supabase
            .from('push_tokens')
            .select('user_id');

        if (usersError) {
            console.error('Error fetching users:', usersError);
            return json({ success: false, error: usersError.message }, 500);
        }

        if (!usersWithTokens || usersWithTokens.length === 0) {
            return json({ success: true, processed: 0 });
        }

        const uniqueUserIds = [...new Set(usersWithTokens.map((u) => u.user_id))];
        let sent = 0;

        for (const userId of uniqueUserIds) {
            try {
                // 1. Проверяем notification_state
                const { data: state } = await supabase
                    .from('notification_state')
                    .select('notifications_enabled, timezone, last_app_open')
                    .eq('user_id', userId)
                    .maybeSingle();

                if (state && state.notifications_enabled === false) continue;

                const timezone = state?.timezone || 'America/New_York';

                // 2. Проверяем, что сейчас 18:00–20:30 по локальному времени
                const { hour, minute } = getUserLocalHour(now, timezone);
                const localMinutes = hour * 60 + minute;
                if (localMinutes < 18 * 60 || localMinutes > 20 * 60 + 30) continue;

                // 3. Проверяем, не открывал ли пользователь приложение за последние 24 часа
                if (state?.last_app_open) {
                    const lastOpen = new Date(state.last_app_open);
                    if (now.getTime() - lastOpen.getTime() < HOURS_24) continue;
                }

                // 4. Проверяем последнюю запись в дневнике (>72 часов?)
                const { data: lastJournal } = await supabase
                    .from('journal')
                    .select('created_at')
                    .eq('user_id', userId)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (lastJournal) {
                    const lastJournalTime = new Date(lastJournal.created_at);
                    if (now.getTime() - lastJournalTime.getTime() < HOURS_72) continue;
                }
                // Если записей нет вообще — тоже шлём nudge (пользователь ни разу не писал)

                // 5. Проверяем, не было ли journal_nudge за последние 72 часа
                const cutoff72h = new Date(now.getTime() - HOURS_72);
                const { data: recentNudge } = await supabase
                    .from('notification_log')
                    .select('id')
                    .eq('user_id', userId)
                    .eq('type', 'journal_nudge')
                    .gte('sent_at', cutoff72h.toISOString())
                    .limit(1)
                    .maybeSingle();

                if (recentNudge) continue;

                // 6. Проверяем подавление: planner-уведомления сегодня
                const todayStr = getUserLocalDateStr(now, timezone);
                const todayStartUtc = new Date(`${todayStr}T00:00:00Z`);

                const { data: plannerToday } = await supabase
                    .from('notification_log')
                    .select('id')
                    .eq('user_id', userId)
                    .in('type', ['task_reminder', 'overdue_task'])
                    .gte('sent_at', todayStartUtc.toISOString())
                    .limit(1)
                    .maybeSingle();

                if (plannerToday) continue;

                // 7. Получаем push-токены
                const { data: tokens } = await supabase
                    .from('push_tokens')
                    .select('token')
                    .eq('user_id', userId);

                if (!tokens || tokens.length === 0) continue;

                // 8. Отправляем
                const nudgeText = pickRandom(NUDGE_COPIES);

                await sendExpoPush(
                    tokens.map((t) => t.token),
                    nudgeText,
                    '',
                );

                // 9. Логируем
                await supabase.from('notification_log').insert({
                    user_id: userId,
                    type: 'journal_nudge',
                    reference_id: null,
                    title: nudgeText,
                    body: '',
                });

                sent++;
                console.log(`Sent journal nudge to user=${userId}`);

            } catch (userErr) {
                console.error(`Error processing user ${userId}:`, userErr.message);
            }
        }

        console.log(`Journal nudges processed: ${sent} sent out of ${uniqueUserIds.length} users`);
        return json({ success: true, processed: sent });

    } catch (error) {
        console.error('Error:', error);
        return json({ success: false, error: error.message }, 500);
    }
});
