import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function: task-calendary
 *
 * Описание:
 * Принимает интервал дат и возвращает процент выполненных задач по каждому дню.
 *
 * Способы вызова:
 * - GET /task-calendary?date_from=2025-11-01&date_to=2025-11-30
 * - POST /task-calendary { "date_from": "2025-11-01", "date_to": "2025-11-30" }
 *
 * Требуется Authorization: Bearer <token>
 *
 * Формат ответа:
 * {
 *   "success": true,
 *   "data": [
 *     { "date": "2025-11-01", "done": "100%" },
 *     { "date": "2025-11-02", "done": "50%" }
 *   ]
 * }
 */

const normalizeDate = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return trimmed;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (!['GET', 'POST'].includes(req.method)) {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Missing authorization token');
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: authHeader },
        },
        auth: {
          persistSession: false,
          detectSessionInUrl: false,
        },
      },
    );

    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      throw new Error('User not authenticated');
    }

    let dateFrom = null;
    let dateTo = null;

    if (req.method === 'GET') {
      const url = new URL(req.url);
      dateFrom = normalizeDate(url.searchParams.get('date_from'));
      dateTo = normalizeDate(url.searchParams.get('date_to'));
    } else {
      try {
        const body = await req.json();
        dateFrom = normalizeDate(body?.date_from);
        dateTo = normalizeDate(body?.date_to);
      } catch {
        return new Response(
          JSON.stringify({ error: 'Invalid JSON body' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    if (!dateFrom || !dateTo) {
      return new Response(
        JSON.stringify({ error: 'date_from and date_to are required in YYYY-MM-DD format' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (dateFrom > dateTo) {
      return new Response(
        JSON.stringify({ error: 'date_from must be before or equal to date_to' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { data: tasks, error: tasksError } = await supabaseClient
      .from('tasks')
      .select('id, select_date, is_completed')
      .eq('user_id', user.id)
      .gte('select_date', dateFrom)
      .lte('select_date', dateTo)
      .order('select_date', { ascending: true });

    if (tasksError) {
      console.error('❌ Error fetching tasks:', tasksError);
      throw new Error('Failed to fetch tasks');
    }

    const statsMap = new Map();

    (tasks ?? []).forEach((task) => {
      if (!task.select_date) {
        return;
      }
      const dateKey = task.select_date;
      if (!statsMap.has(dateKey)) {
        statsMap.set(dateKey, { total: 0, completed: 0 });
      }
      const stats = statsMap.get(dateKey);
      stats.total += 1;
      if (task.is_completed) {
        stats.completed += 1;
      }
    });

    const response = Array.from(statsMap.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, stats]) => {
        const percent = stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;
        return {
          date,
          done: `${percent}%`,
        };
      });

    return new Response(
      JSON.stringify({
        success: true,
        data: response,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  } catch (error) {
    console.error('❌ Error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || 'Unknown error',
        message: 'Failed to fetch calendar stats',
      }),
      {
        status: error.message?.includes('not authenticated') ? 401 : 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});


