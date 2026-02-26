import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const json = (body, init = {}) => new Response(JSON.stringify(body), {
  ...init,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    ...init.headers || {}
  }
});

const parseCsv = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const nullIfEmpty = (arr) => arr && arr.length ? arr : null;

const MAX_LIMIT = 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({}, { status: 204 });
  
  const url = new URL(req.url);
  let payload = {};
  
  if (req.method === "GET") {
    const q = url.searchParams;
    payload = {
      limit: Number(q.get("limit") ?? "20"),
      cursor_created_at: q.get("cursor_created_at"),
      cursor_id: q.get("cursor_id"),
      search: q.get("search"),
      date_from: q.get("date_from"),
      date_to: q.get("date_to"),
      deadline_from: q.get("deadline_from"),
      deadline_to: q.get("deadline_to"),
      status: q.get("status"),
    };
  } else if (req.method === "POST") {
    try {
      const b = await req.json();
      payload = {
        limit: typeof b.limit === 'number' ? b.limit : 20,
        cursor_created_at: b.cursor_created_at ?? null,
        cursor_id: b.cursor_id ?? null,
        search: b.search ?? null,
        date_from: b.date_from ?? null,
        date_to: b.date_to ?? null,
        deadline_from: b.deadline_from ?? null,
        deadline_to: b.deadline_to ?? null,
        status: b.status ?? null,
      };
    } catch {
      return json({
        error: "Invalid JSON body"
      }, {
        status: 400
      });
    }
  } else {
    return json({
      error: "Method not allowed"
    }, {
      status: 405
    });
  }
  
  const limit = Math.min(Math.max(1, Number.isFinite(payload.limit) ? payload.limit : 20), MAX_LIMIT);
  const cursorCreatedAt = payload.cursor_created_at ?? null;
  const cursorId = payload.cursor_id ?? null;
  const search = payload.search?.trim() || null;
  const dateFrom = payload.date_from?.trim() || null;
  const dateTo = payload.date_to?.trim() || null;
  const deadlineFrom = payload.deadline_from?.trim() || null;
  const deadlineTo = payload.deadline_to?.trim() || null;
  const statusFilter = payload.status?.trim().toLowerCase() || 'all';
  
  // Validate status filter
  const validStatuses = ['all', 'active', 'completed'];
  const status = validStatuses.includes(statusFilter) ? statusFilter : 'all';
  
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? '', 
    Deno.env.get("SUPABASE_ANON_KEY") ?? '', 
    {
      global: {
        headers: {
          Authorization: req.headers.get("Authorization") ?? ""
        }
      },
      auth: {
        persistSession: false,
        detectSessionInUrl: false
      }
    }
  );
  
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  
  if (userError || !user) {
    return json({
      error: "User not authenticated"
    }, {
      status: 401
    });
  }

  // Build query for goals
  // Get more goals to account for filtering by status (need to calculate completionPercentage first)
  // Multiply limit by 3 to ensure we have enough after filtering
  const fetchLimit = status === 'all' ? limit + 1 : (limit * 3) + 1;
  
  let query = supabase
    .from('goals')
    .select('id, title, deadline, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(fetchLimit);

  // Apply search filter
  if (search) {
    const escaped = search.replace(/%/g, '\\%').replace(/_/g, '\\_');
    query = query.ilike('title', `%${escaped}%`);
  }

  // Apply date filters (created_at)
  if (dateFrom) {
    query = query.gte('created_at', dateFrom);
  }
  if (dateTo) {
    query = query.lte('created_at', dateTo);
  }

  // Apply deadline filters
  if (deadlineFrom) {
    query = query.gte('deadline', deadlineFrom);
  }
  if (deadlineTo) {
    query = query.lte('deadline', deadlineTo);
  }

  // Apply cursor pagination
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
    return json({
      error: goalsError.message || "Failed to fetch goals"
    }, {
      status: 500
    });
  }

  const rows = goals ?? [];
  rows.sort((a, b) => {
    if (a.created_at === b.created_at) {
      return a.id < b.id ? 1 : -1;
    }
    return new Date(a.created_at) < new Date(b.created_at) ? 1 : -1;
  });

  // Get all tasks attached to these goals (before filtering by status)
  const goalIds = rows.map((goal) => goal.id);

  if (goalIds.length === 0) {
    return json({
      items: [],
      next_cursor: null
    });
  }

  const { data: taskGoals, error: taskGoalsError } = await supabase
    .from('task_goals')
    .select('goal_id, tasks:tasks!inner(id, is_completed)')
    .in('goal_id', goalIds)
    .eq('tasks.user_id', user.id);

  if (taskGoalsError) {
    console.error('Failed to fetch task-goals:', taskGoalsError);
    return json({
      error: "Failed to fetch task-goals"
    }, {
      status: 500
    });
  }

  // Group tasks by goals and get all task_ids
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

  // Get all subtasks for these tasks
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
      return json({
        error: "Failed to fetch subtasks"
      }, {
        status: 500
      });
    }

    // Group subtasks by task_id
    (subtasks || []).forEach((subtask) => {
      const taskId = subtask.task_id;
      if (!subtasksByTask.has(taskId)) {
        subtasksByTask.set(taskId, []);
      }
      subtasksByTask.get(taskId).push(subtask);
    });
  }

  // Calculate completion percentage for each goal (including tasks and subtasks)
  const formatted = rows.map((goal) => {
    const tasks = tasksByGoal.get(goal.id) || [];
    
    // Count tasks
    let totalItems = tasks.length;
    let completedItems = tasks.filter((t) => t.is_completed).length;

    // Add subtasks for each task
    tasks.forEach((task) => {
      const subtasks = subtasksByTask.get(task.id) || [];
      totalItems += subtasks.length;
      completedItems += subtasks.filter((st) => st.is_completed).length;
    });

    // If there are no incomplete items (tasks and subtasks), it's 100% complete
    // If there are no items at all, also consider it 100%
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
      completionPercentage
    };
  });

  // Apply status filter (all/active/completed)
  let filteredItems = formatted;
  if (status === 'active') {
    filteredItems = formatted.filter(goal => goal.completionPercentage < 100);
  } else if (status === 'completed') {
    filteredItems = formatted.filter(goal => goal.completionPercentage === 100);
  }

  // Apply pagination to filtered results
  let paginatedItems = filteredItems;
  let paginatedNextCursor = null;

  if (filteredItems.length > limit) {
    const sliced = filteredItems.slice(0, limit);
    const last = sliced[sliced.length - 1];
    paginatedNextCursor = last ? {
      created_at: last.createdAt,
      id: last.id
    } : null;
    paginatedItems = sliced;
  } else if (filteredItems.length > 0) {
    const last = filteredItems[filteredItems.length - 1];
    paginatedNextCursor = last ? {
      created_at: last.createdAt,
      id: last.id
    } : null;
  }

  return json({
    items: paginatedItems,
    next_cursor: paginatedNextCursor
  });
});
