
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * Supabase Edge Function: task-pagination
 *
 * Пример вызова (GET):
 *   GET /functions/v1/task-pagination?limit=20&search=demo&repeat=Weekly&reminder=tenMinutes&is_completed=false&tag_ids=<UUID1>,<UUID2>
 *
 * Пример вызова (POST):
 *   POST /functions/v1/task-pagination
 *   Authorization: Bearer <user access token>
 *   Content-Type: application/json
 *   Body:
 *   {
 *     "limit": 20,                       // опционально, 1..100, по умолчанию 20
 *     "cursor_created_at": "2025-04-01T12:00:00+00:00",
 *     "cursor_id": "task-uuid",
 *     "search": "demo",                  // поиск по названию/описанию (ilike)
 *     "tag_ids": ["uuid-1", "uuid-2"],   // фильтр по тегам пользователя
 *     "date_from": "2025-04-01",         // фильтр по select_date >=
 *     "date_to": "2025-04-30",           // фильтр по select_date <=
 *     "is_completed": false,             // фильтр по статусу задачи
 *     "has_goals": true,                 // фильтр: показывать только задачи, прикрепленные к целям
 *     "repeat": ["Weekly", "Monthly"],   // фильтр по значению repeat (No Repeats, Daily, Weekly, Bi-weekly, Monthly, Annually, Custom)
 *     "reminder": ["tenMinutes", "oneHour"] // фильтр по значению reminder (noReminders, fiveMinutes, tenMinutes, fifteenMinutes, thirtyMinutes, oneHour, oneDay)
 *   }
 *
 * Ответ:
 * {
 *   "items": [
 *     {
 *       "id": "...",
 *       "title": "...",
 *       "description": "...",
 *       "selectDate": "YYYY-MM-DD",
 *       "selectTime": "HH:MM:SS",
 *       "repeat": "Weekly",
 *       "reminder": "noReminders",
 *       "isCompleted": false,
 *       "createdAt": "2025-04-01T12:00:00+00:00",
 *       "tags": [{ "id": "...", "name": "..." }],
 *       "subtasks": [{ "id": "...", "title": "...", "isCompleted": false, "createdAt": "..." }],
 *       "images": [{ "id": "...", "url": "...", "createdAt": "..." }],
 *       "audio": [{ "id": "...", "url": "...", "createdAt": "..." }],
 *       "countMedia": 2
 *     }
 *   ],
 *   "next_cursor": {                     // null, если больше страниц нет
 *     "created_at": "2025-04-01T12:00:00+00:00",
 *     "id": "task-uuid"
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

const parseCsv = (value) =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

const normalizeUuidArray = (value) => {
  if (!Array.isArray(value)) return null;
  const uuids = value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => /^[0-9a-fA-F-]{36}$/.test(v));
  return uuids.length > 0 ? uuids : null;
};

const parseBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 't', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'f', 'no', 'n'].includes(normalized)) return false;
  return null;
};

const MAX_LIMIT = 100;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return json({}, { status: 204 });
  }

  if (!['GET', 'POST'].includes(req.method)) {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  const url = new URL(req.url);
  let payload = {};

  if (req.method === 'GET') {
    const q = url.searchParams;
    const tagIdsCsv = parseCsv(q.get('tag_ids'));
    payload = {
      limit: Number(q.get('limit') ?? '20'),
      cursor_created_at: q.get('cursor_created_at'),
      cursor_id: q.get('cursor_id'),
      search: q.get('search'),
      tag_ids: tagIdsCsv,
      date_from: q.get('date_from'),
      date_to: q.get('date_to'),
      is_completed: parseBoolean(q.get('is_completed')),
      has_goals: parseBoolean(q.get('has_goals')),
      repeat: parseCsv(q.get('repeat')),
      reminder: parseCsv(q.get('reminder')),
    };
  } else {
    try {
      const body = await req.json();
      const rawTagIds = Array.isArray(body.tag_ids)
        ? body.tag_ids
        : typeof body.tag_ids === 'string'
          ? parseCsv(body.tag_ids)
          : null;

      const parsedIsCompleted = body.hasOwnProperty('is_completed')
        ? parseBoolean(body.is_completed)
        : null;

      const parsedHasGoals = body.hasOwnProperty('has_goals')
        ? parseBoolean(body.has_goals)
        : null;

      payload = {
        limit: typeof body.limit === 'number' ? body.limit : 20,
        cursor_created_at: typeof body.cursor_created_at === 'string' ? body.cursor_created_at : null,
        cursor_id: typeof body.cursor_id === 'string' ? body.cursor_id : null,
        search: typeof body.search === 'string' ? body.search : null,
        tag_ids: rawTagIds,
        date_from: typeof body.date_from === 'string' ? body.date_from : null,
        date_to: typeof body.date_to === 'string' ? body.date_to : null,
        is_completed: parsedIsCompleted,
        has_goals: parsedHasGoals,
        repeat: Array.isArray(body.repeat)
          ? body.repeat.filter((val) => typeof val === 'string' && val.trim().length > 0)
          : null,
        reminder: Array.isArray(body.reminder)
          ? body.reminder.filter((val) => typeof val === 'string' && val.trim().length > 0)
          : null,
      };
    } catch {
      return json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  const limit = Math.min(Math.max(1, Number.isFinite(payload.limit) ? payload.limit : 20), MAX_LIMIT);
  const cursorCreatedAt = payload.cursor_created_at ?? null;
  const cursorId = payload.cursor_id ?? null;
  const search = payload.search?.trim() || null;
  const tagIdsParam = normalizeUuidArray(payload.tag_ids ?? null);
  const dateFrom = payload.date_from?.trim() || null;
  const dateTo = payload.date_to?.trim() || null;
  const repeatFilters = Array.isArray(payload.repeat) && payload.repeat.length ? payload.repeat : null;
  const reminderFilters = Array.isArray(payload.reminder) && payload.reminder.length ? payload.reminder : null;
  const isCompletedFilter = typeof payload.is_completed === 'boolean' ? payload.is_completed : null;
  const hasGoalsFilter = typeof payload.has_goals === 'boolean' ? payload.has_goals : null;

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

  let filteredTaskIds = null;
  if (tagIdsParam) {
    const { data: tagTaskRows, error: tagTaskError } = await supabase
      .from('task_tags')
      .select('task_id, task:tasks!inner(user_id)')
      .in('tag_id', tagIdsParam)
      .eq('task.user_id', user.id);

    if (tagTaskError) {
      console.error('Failed to fetch task tags:', tagTaskError);
      return json({ error: 'Failed to filter by tags' }, { status: 500 });
    }

    filteredTaskIds = Array.from(new Set((tagTaskRows ?? []).map((row) => row.task_id))).filter(Boolean);
    if (filteredTaskIds.length === 0) {
      return json({ items: [], next_cursor: null });
    }
  }

  // Определяем тип join для task_goals: inner если нужны только задачи с целями, left иначе
  const taskGoalsJoinType = hasGoalsFilter === true ? 'inner' : 'left';
  const selectQuery = `
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
      task_goals!${taskGoalsJoinType} (
        goal_id
      )
    `;

  let query = supabase
    .from('tasks')
    .select(selectQuery)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);

  if (filteredTaskIds) {
    query = query.in('id', filteredTaskIds);
  }

  if (search) {
    const escaped = search.replace(/%/g, '\\%').replace(/_/g, '\\_');
    query = query.or(`title.ilike.%${escaped}%,description.ilike.%${escaped}%`);
  }

  if (dateFrom) {
    query = query.gte('select_date', dateFrom);
  }
  if (dateTo) {
    query = query.lte('select_date', dateTo);
  }

  if (repeatFilters) {
    query = query.in('repeat', repeatFilters);
  }

  if (reminderFilters) {
    query = query.in('reminder', reminderFilters);
  }

  if (isCompletedFilter !== null) {
    query = query.eq('is_completed', isCompletedFilter);
  }

  if (cursorCreatedAt || cursorId) {
    const filters = [];
    if (cursorCreatedAt) {
      filters.push(`created_at.lt.${cursorCreatedAt}`);
    }
    if (cursorCreatedAt && cursorId) {
      filters.push(`and(created_at.eq.${cursorCreatedAt},id.lt.${cursorId})`);
    }
    if (!cursorCreatedAt && cursorId) {
      filters.push(`id.lt.${cursorId}`);
    }
    if (filters.length > 0) {
      query = query.or(filters.join(','));
    }
  }

  const { data, error } = await query;

  if (error) {
    console.error('Failed to fetch tasks:', error);
    return json({ error: 'Failed to fetch tasks' }, { status: 500 });
  }

  const rows = data ?? [];
  rows.sort((a, b) => {
    if (a.created_at === b.created_at) {
      return a.id < b.id ? 1 : -1;
    }
    return new Date(a.created_at) < new Date(b.created_at) ? 1 : -1;
  });

  let items = rows;
  let nextCursor = null;

  if (rows.length > limit) {
    const sliced = rows.slice(0, limit);
    const last = sliced[sliced.length - 1];
    nextCursor = last
      ? {
          created_at: last.created_at,
          id: last.id,
        }
      : null;
    items = sliced;
  } else if (rows.length > 0) {
    const last = rows[rows.length - 1];
    nextCursor = last
      ? {
          created_at: last.created_at,
          id: last.id,
        }
      : null;
  }

  const formatted = items.map((task) => {
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

    return {
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
  });

  return json({
    items: formatted,
    next_cursor: nextCursor,
  });
});

