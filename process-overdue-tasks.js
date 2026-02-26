import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * Supabase Edge Function: process-overdue-tasks
 *
 * Вызывается по cron (каждые 15 минут).
 * Находит незавершённые задачи, у которых прошло >1 час после due time, и шлёт push.
 *
 * Логика (из спецификации):
 * - Триггер: задача не завершена + 1 час после due time
 * - Отправляется ОДИН раз на задачу
 * - Отменяется, если задача завершена до срабатывания
 *
 * Title (рандомный из списка):
 *   Still doing this today? / Quick reminder: / Want to reschedule it? /
 *   Still on your list today? / Keep it or move it?
 * Body: {Task name}
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

const OVERDUE_TITLES = [
    'Still doing this today?',
    'Quick reminder:',
    'Want to reschedule it?',
    'Still on your list today?',
    'Keep it or move it?',
];

const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

const MAX_TITLE_LENGTH = 100;
const trimTitle = (title) =>
    title.length > MAX_TITLE_LENGTH
        ? title.slice(0, MAX_TITLE_LENGTH - 1) + '…'
        : title;

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

        // Задачи с датой и временем, не завершённые
        const { data: tasks, error: tasksError } = await supabase
            .from('tasks')
            .select('id, user_id, title, select_date, select_time, is_completed')
            .eq('is_completed', false)
            .not('select_date', 'is', null)
            .not('select_time', 'is', null);

        if (tasksError) {
            console.error('Error fetching tasks:', tasksError);
            return json({ success: false, error: tasksError.message }, 500);
        }

        if (!tasks || tasks.length === 0) {
            return json({ success: true, processed: 0 });
        }

        let sent = 0;

        for (const task of tasks) {
            const taskDateTime = new Date(`${task.select_date}T${task.select_time}Z`);
            const overdueTime = new Date(taskDateTime.getTime() + 60 * 60 * 1000); // +1 час

            // Проверяем, что прошёл 1 час (но не более 24 часов — чтобы не спамить старыми задачами)
            const diffMs = now.getTime() - overdueTime.getTime();
            if (diffMs < 0 || diffMs > 24 * 60 * 60 * 1000) continue;

            // Проверяем, не отправлено ли уже (one-time per task)
            const { data: existing } = await supabase
                .from('notification_log')
                .select('id')
                .eq('user_id', task.user_id)
                .eq('type', 'overdue_task')
                .eq('reference_id', task.id)
                .limit(1)
                .maybeSingle();

            if (existing) continue;

            // Проверяем, включены ли уведомления
            const { data: state } = await supabase
                .from('notification_state')
                .select('notifications_enabled')
                .eq('user_id', task.user_id)
                .maybeSingle();

            if (state && state.notifications_enabled === false) continue;

            // Получаем push-токены
            const { data: tokens } = await supabase
                .from('push_tokens')
                .select('token')
                .eq('user_id', task.user_id);

            if (!tokens || tokens.length === 0) continue;

            const title = pickRandom(OVERDUE_TITLES);
            const body = trimTitle(task.title);

            await sendExpoPush(tokens.map((t) => t.token), title, body);

            await supabase.from('notification_log').insert({
                user_id: task.user_id,
                type: 'overdue_task',
                reference_id: task.id,
                title,
                body,
            });

            sent++;
            console.log(`Sent overdue notification: task=${task.id} user=${task.user_id}`);
        }

        console.log(`Overdue tasks processed: ${sent} sent out of ${tasks.length} candidates`);
        return json({ success: true, processed: sent });

    } catch (error) {
        console.error('Error:', error);
        return json({ success: false, error: error.message }, 500);
    }
});
