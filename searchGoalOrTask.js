import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function для поиска по целям и задачам
 * 
 * Возвращает результаты поиска по названию и описанию в таблицах goals и tasks
 * 
 * Query params (GET) или JSON body (POST):
 * - query: строка поиска (обязательно)
 * - limit: максимальное число результатов для каждого типа (default 20)
 * 
 * Формат ответа:
 * {
 *   goals: [
 *     { id, title, deadline, createdAt, completionPercentage }
 *   ],
 *   tasks: [
 *     { id, title, description, selectDate, isCompleted, createdAt, tags }
 *   ]
 * }
 */

Deno.serve(async (req) => {
  // Обработка CORS preflight запроса
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  try {
    // Создание Supabase клиента с токеном пользователя
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
      }
    );

    // Проверка аутентификации пользователя
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      throw new Error('User not authenticated');
    }

    // Получаем параметры запроса
    const url = new URL(req.url);
    let searchQuery = '';
    let limit = 20;

    if (req.method === 'GET') {
      searchQuery = url.searchParams.get('query') || '';
      limit = Number(url.searchParams.get('limit') ?? limit) || limit;
    } else if (req.method === 'POST') {
      try {
        const body = await req.json();
        searchQuery = typeof body.query === 'string' ? body.query.trim() : '';
        limit = typeof body.limit === 'number' ? body.limit : limit;
      } catch {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Invalid JSON body',
          }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }
    } else {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Method not allowed',
        }),
        {
          status: 405,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    if (!searchQuery || searchQuery.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Search query is required',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    console.log(`🔍 Searching for: "${searchQuery}" (limit: ${limit})`);

    // Экранируем специальные символы для ilike
    const escapedQuery = searchQuery.replace(/%/g, '\\%').replace(/_/g, '\\_');

    // Параллельно ищем в goals и tasks
    const [goalsResult, tasksResult] = await Promise.all([
      // Поиск в goals
      supabaseClient
        .from('goals')
        .select('id, title, deadline, created_at')
        .eq('user_id', user.id)
        .or(`title.ilike.%${escapedQuery}%`)
        .order('created_at', { ascending: false })
        .limit(limit),
      
      // Поиск в tasks
      supabaseClient
        .from('tasks')
        .select('id, title, description, select_date, is_completed, created_at')
        .eq('user_id', user.id)
        .or(`title.ilike.%${escapedQuery}%,description.ilike.%${escapedQuery}%`)
        .order('created_at', { ascending: false })
        .limit(limit),
    ]);

    if (goalsResult.error) {
      console.error('❌ Error searching goals:', goalsResult.error);
    }
    if (tasksResult.error) {
      console.error('❌ Error searching tasks:', tasksResult.error);
    }

    const goals = goalsResult.data || [];
    const tasks = tasksResult.data || [];

    // Для goals нужно вычислить completionPercentage
    const goalIds = goals.map(g => g.id);
    let goalsWithCompletion = goals;

    if (goalIds.length > 0) {
      // Получаем задачи для этих целей
      const { data: taskGoals, error: taskGoalsError } = await supabaseClient
        .from('task_goals')
        .select('goal_id, tasks:tasks!inner(id, is_completed)')
        .in('goal_id', goalIds)
        .eq('tasks.user_id', user.id);

      if (!taskGoalsError && taskGoals) {
        // Группируем задачи по целям
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
          const { data: subtasks, error: subtasksError } = await supabaseClient
            .from('subtasks')
            .select('id, task_id, is_completed')
            .in('task_id', taskIdsArray)
            .eq('user_id', user.id);

          if (!subtasksError && subtasks) {
            subtasks.forEach((subtask) => {
              const taskId = subtask.task_id;
              if (!subtasksByTask.has(taskId)) {
                subtasksByTask.set(taskId, []);
              }
              subtasksByTask.get(taskId).push(subtask);
            });
          }
        }

        // Вычисляем completionPercentage для каждой цели
        goalsWithCompletion = goals.map((goal) => {
          const goalTasks = tasksByGoal.get(goal.id) || [];
          
          let totalItems = goalTasks.length;
          let completedItems = goalTasks.filter((t) => t.is_completed).length;

          goalTasks.forEach((task) => {
            const subtasks = subtasksByTask.get(task.id) || [];
            totalItems += subtasks.length;
            completedItems += subtasks.filter((st) => st.is_completed).length;
          });

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
      } else {
        // Если не удалось получить задачи, просто добавляем completionPercentage = 0
        goalsWithCompletion = goals.map((goal) => ({
          id: goal.id,
          title: goal.title,
          deadline: goal.deadline,
          createdAt: goal.created_at,
          completionPercentage: 0,
        }));
      }
    }

    // Для tasks получаем теги
    const taskIds = tasks.map(t => t.id);
    let tasksWithTags = tasks;

    if (taskIds.length > 0) {
      const { data: taskTags, error: tagsError } = await supabaseClient
        .from('task_tags')
        .select('task_id, tags_tasks(id, name)')
        .in('task_id', taskIds);

      if (!tagsError && taskTags) {
        const tagsByTask = new Map();
        taskTags.forEach((tt) => {
          if (!tt.tags_tasks) return;
          const arr = tagsByTask.get(tt.task_id) || [];
          arr.push({ id: tt.tags_tasks.id, name: tt.tags_tasks.name });
          tagsByTask.set(tt.task_id, arr);
        });

        tasksWithTags = tasks.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          selectDate: task.select_date,
          isCompleted: task.is_completed,
          createdAt: task.created_at,
          tags: tagsByTask.get(task.id) || [],
        }));
      } else {
        tasksWithTags = tasks.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          selectDate: task.select_date,
          isCompleted: task.is_completed,
          createdAt: task.created_at,
          tags: [],
        }));
      }
    }

    console.log(`✅ Found ${goalsWithCompletion.length} goals and ${tasksWithTags.length} tasks`);

    // Возвращаем результат
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          goals: goalsWithCompletion,
          tasks: tasksWithTags,
        },
        message: 'Search completed successfully',
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );

  } catch (error) {
    console.error('❌ Error:', error);
    
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || 'An unknown error occurred',
        message: 'Failed to perform search',
      }),
      {
        status: error.message?.includes('not authenticated') ? 401 : 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }
});


