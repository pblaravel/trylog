import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * Supabase Edge Function: task-by-id
 *
 * Возвращает все данные по одной задаче по её ID:
 * - Основная информация (title, description, select_date, select_time, repeat, reminder, is_completed, created_at)
 * - Теги (через task_tags -> tags_tasks)
 * - Subtasks
 * - Картинки (task_image)
 * - Аудио (task_audio)
 * - Флаг наличия связанных целей (isGoals)
 *
 * Пример вызова (GET):
 *   GET /functions/v1/task-by-id?id=<task_uuid>
 *
 * Пример вызова (POST):
 *   POST /functions/v1/task-by-id
 *   Authorization: Bearer <user access token>
 *   Content-Type: application/json
 *   Body:
 *   {
 *     "id": "<task_uuid>"
 *   }
 *
 * Ответ (успешный):
 * {
 *   "item": {
 *     "id": "...",
 *     "title": "...",
 *     "description": "...",
 *     "selectDate": "YYYY-MM-DD",
 *     "selectTime": "HH:MM:SS",
 *     "repeat": "Weekly",
 *     "reminder": "noReminders",
 *     "isCompleted": false,
 *     "createdAt": "2025-04-01T12:00:00+00:00",
 *     "tags": [{ "id": "...", "name": "..." }],
 *     "subtasks": [{ "id": "...", "title": "...", "isCompleted": false, "createdAt": "..." }],
 *     "images": [{ "id": "...", "url": "...", "createdAt": "..." }],
 *     "audio": [{ "id": "...", "url": "...", "createdAt": "..." }],
 *     "countMedia": 2,
 *     "isGoals": true
 *   }
 * }
 */

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      ...(init.headers ?? {}),
    },
  });

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return json({}, { status: 204 });
  }

  if (!['GET', 'POST'].includes(req.method)) {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  const url = new URL(req.url);
  let taskId = null;

  if (req.method === 'GET') {
    taskId = url.searchParams.get('id');
  } else {
    try {
      const body = await req.json();
      if (typeof body.id === 'string') {
        taskId = body.id.trim();
      }
    } catch {
      return json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  if (!taskId) {
    return json(
      {
        error: 'Task ID is required',
        message: 'Provide task id via query (?id=<uuid>) or JSON body { "id": "<uuid>" }',
      },
      { status: 400 },
    );
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    {
      global: {
        headers: {
          Authorization: req.headers.get('Authorization') ?? '',
        },
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
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return json({ error: 'User not authenticated' }, { status: 401 });
  }

  // Берём данные по задаче в том же формате, что и в task-pagination,
  // чтобы фронт мог переиспользовать одну и ту же модель.
  const { data, error } = await supabase
    .from('tasks')
    .select(`
      id,
      title,
      description,
      select_date,
      select_time,
      repeat,
      reminder,
      is_completed,
      created_at,
      task_tags:task_tags (
        tag_id,
        tags:tags_tasks (
          id,
          name
        )
      ),
      subtasks (
        id,
        title,
        is_completed,
        created_at
      ),
      task_image (
        id,
        url,
        created_at
      ),
      task_audio (
        id,
        url,
        created_at
      ),
      task_goals!left (
        goal_id
      )
    `)
    .eq('user_id', user.id)
    .eq('id', taskId)
    .maybeSingle();

  if (error) {
    // PGRST116 — не найдено
    if (error.code === 'PGRST116') {
      return json(
        {
          error: 'Task not found',
          message: 'The requested task does not exist or you do not have access to it',
        },
        { status: 404 },
      );
    }

    console.error('Failed to fetch task by id:', error);
    return json({ error: 'Failed to fetch task' }, { status: 500 });
  }

  if (!data) {
    return json(
      {
        error: 'Task not found',
        message: 'The requested task does not exist or you do not have access to it',
      },
      { status: 404 },
    );
  }

  const task = data;

  const tags = (task.task_tags ?? [])
    .map((tt) => tt.tags)
    .filter(Boolean)
    .map((tag) => ({ id: tag.id, name: tag.name }));

  const images = (task.task_image ?? []).map((img) => ({
    id: img.id,
    url: img.url,
    createdAt: img.created_at,
  }));

  const audio = (task.task_audio ?? []).map((aud) => ({
    id: aud.id,
    url: aud.url,
    createdAt: aud.created_at,
  }));

  const subtasks = (task.subtasks ?? []).map((sub) => ({
    id: sub.id,
    title: sub.title,
    isCompleted: sub.is_completed,
    createdAt: sub.created_at,
  }));

  const item = {
    id: task.id,
    title: task.title,
    description: task.description,
    selectDate: task.select_date,
    selectTime: task.select_time,
    repeat: task.repeat,
    reminder: task.reminder,
    isCompleted: task.is_completed,
    createdAt: task.created_at,
    tags,
    subtasks,
    images,
    audio,
    countMedia: images.length + audio.length,
    isGoals: Array.isArray(task.task_goals) && task.task_goals.some((goal) => goal?.goal_id),
  };

  return json({ item });
});


