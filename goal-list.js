import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * Supabase Edge Function: goal-list
 *
 * Возвращает список целей с пагинацией и процентом выполнения.
 * Для каждой цели считаются все прикрепленные таски и их subtasks.
 * Если незавершенных тасков и subtasks нет, значит выполнено на 100%.
 *
 * Пример вызова (GET):
 *   GET /functions/v1/goal-list?limit=20&cursor_created_at=2025-04-01T12:00:00+00:00&cursor_id=goal-uuid
 *
 * Пример вызова (POST):
 *   POST /functions/v1/goal-list
 *   Authorization: Bearer <user access token>
 *   Content-Type: application/json
 *   Body:
 *   {
 *     "limit": 20,
 *     "cursor_created_at": "2025-04-01T12:00:00+00:00",
 *     "cursor_id": "goal-uuid"
 *   }
 *
 * Ответ:
 * {
 *   "items": [
 *     {
 *       "id": "...",
 *       "title": "...",
 *       "deadline": "2025-12-31",
 *       "createdAt": "2025-04-01T12:00:00+00:00",
 *       "completionPercentage": 75
 *     }
 *   ],
 *   "next_cursor": {
 *     "created_at": "2025-04-01T12:00:00+00:00",
 *     "id": "goal-uuid"
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
    payload = {
      limit: Number(q.get('limit') ?? '20'),
      cursor_created_at: q.get('cursor_created_at'),
      cursor_id: q.get('cursor_id'),
    };
  } else {
    try {
      const body = await req.json();
      payload = {
        limit: typeof body.limit === 'number' ? body.limit : 20,
        cursor_created_at: typeof body.cursor_created_at === 'string' ? body.cursor_created_at : null,
        cursor_id: typeof body.cursor_id === 'string' ? body.cursor_id : null,
      };
    } catch {
      return json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  const limit = Math.min(Math.max(1, Number.isFinite(payload.limit) ? payload.limit : 20), MAX_LIMIT);
  const cursorCreatedAt = payload.cursor_created_at ?? null;
  const cursorId = payload.cursor_id ?? null;

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

  // Получаем цели с пагинацией
  let query = supabase
    .from('goals')
    .select('id, title, deadline, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);

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

  const { data: goals, error: goalsError } = await query;

  if (goalsError) {
    console.error('Failed to fetch goals:', goalsError);
    return json({ error: 'Failed to fetch goals' }, { status: 500 });
  }

  const rows = goals ?? [];
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

  // Получаем все задачи, прикрепленные к этим целям
  const goalIds = items.map((goal) => goal.id);

  if (goalIds.length === 0) {
    return json({
      items: [],
      next_cursor: null,
    });
  }

  const { data: taskGoals, error: taskGoalsError } = await supabase
    .from('task_goals')
    .select('goal_id, tasks:tasks!inner(id, is_completed)')
    .in('goal_id', goalIds)
    .eq('tasks.user_id', user.id);

  if (taskGoalsError) {
    console.error('Failed to fetch task-goals:', taskGoalsError);
    return json({ error: 'Failed to fetch task-goals' }, { status: 500 });
  }

  // Группируем задачи по целям и получаем все task_id
  const tasksByGoal = new Map();
  const allTaskIds = new Set();
  (taskGoals || []).forEach((tg) => {
    if (!tg.tasks) return;
    const goalId = tg.goal_id;
    const taskId = tg.tasks.id;
    allTaskIds.add(taskId);
    if (!tasksByGoal.has(goalId)) {
      tasksByGoal.set(goalId, []);
    }
    tasksByGoal.get(goalId).push(tg.tasks);
  });

  // Получаем все subtasks для этих тасков
  const taskIdsArray = Array.from(allTaskIds);
  let subtasksByTask = new Map();
  if (taskIdsArray.length > 0) {
    const { data: subtasks, error: subtasksError } = await supabase
      .from('subtasks')
      .select('id, task_id, is_completed')
      .in('task_id', taskIdsArray)
      .eq('user_id', user.id);

    if (subtasksError) {
      console.error('Failed to fetch subtasks:', subtasksError);
      return json({ error: 'Failed to fetch subtasks' }, { status: 500 });
    }

    // Группируем subtasks по task_id
    (subtasks || []).forEach((subtask) => {
      const taskId = subtask.task_id;
      if (!subtasksByTask.has(taskId)) {
        subtasksByTask.set(taskId, []);
      }
      subtasksByTask.get(taskId).push(subtask);
    });
  }

  // Вычисляем процент выполнения для каждой цели (с учетом тасков и subtasks)
  const formatted = items.map((goal) => {
    const tasks = tasksByGoal.get(goal.id) || [];
    
    // Считаем таски
    let totalItems = tasks.length;
    let completedItems = tasks.filter((t) => t.is_completed).length;

    // Добавляем subtasks для каждого таска
    tasks.forEach((task) => {
      const subtasks = subtasksByTask.get(task.id) || [];
      totalItems += subtasks.length;
      completedItems += subtasks.filter((st) => st.is_completed).length;
    });

    // Если нет незавершенных элементов (тасков и subtasks), значит выполнено на 100%
    // Если нет элементов вообще, тоже считаем 100%
    let completionPercentage = 100;
    const incompleteItems = totalItems - completedItems;
    if (totalItems > 0 && incompleteItems > 0) {
      completionPercentage = Math.round((completedItems / totalItems) * 100);
    }

    return {
      id: goal.id,
      title: goal.title,
      deadline: goal.deadline,
      createdAt: goal.created_at,
      completionPercentage,
    };
  });

  return json({
    items: formatted,
    next_cursor: nextCursor,
  });
});
