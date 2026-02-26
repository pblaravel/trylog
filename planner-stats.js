import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function: planner-stats
 *
 * Возвращает статистику по целям пользователя для отображения в баннере приложения.
 *
 * Пример вызова:
 * GET /functions/v1/planner-stats
 * Authorization: Bearer <user access token>
 *
 * Ответ:
 * {
 *   "success": true,
 *   "data": {
 *     "goals": [
 *       {
 *         "id": "...",
 *         "title": "Planner",
 *         "deadline": "2025-12-31",
 *         "totalTasks": 50,
 *         "completedTasks": 42,
 *         "completionRate": 84,
 *         "completedThisWeek": 5,
 *         "completedThisMonth": 12,
 *         "daysLeft": 32
 *       }
 *     ],
 *     "summary": {
 *       "totalTasksCompleted": 342,
 *       "daysPlanned": 32
 *     }
 *   }
 * }
 */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
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
      }
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      throw new Error('User not authenticated');
    }

    console.log(`📊 Fetching planner stats for user: ${user.id}`);

    // Получаем все цели пользователя
    const { data: goals, error: goalsError } = await supabaseClient
      .from('goals')
      .select('id, title, deadline, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (goalsError) {
      console.error('❌ Error fetching goals:', goalsError);
      throw new Error(`Failed to fetch goals: ${goalsError.message}`);
    }

    if (!goals || goals.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            goals: [],
            summary: {
              totalTasksCompleted: 0,
              daysPlanned: 0,
            },
          },
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const goalIds = goals.map((g) => g.id);
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Получаем все задачи, связанные с целями пользователя
    const { data: taskGoals, error: taskGoalsError } = await supabaseClient
      .from('task_goals')
      .select('goal_id, task_id, tasks:tasks!inner(id, is_completed, created_at, updated_at, select_date)')
      .in('goal_id', goalIds)
      .eq('tasks.user_id', user.id);

    if (taskGoalsError) {
      console.error('❌ Error fetching task-goals:', taskGoalsError);
      throw new Error(`Failed to fetch task-goals: ${taskGoalsError.message}`);
    }

    // Группируем задачи по целям
    const tasksByGoal = new Map();
    (taskGoals || []).forEach((tg) => {
      if (!tg.tasks) return;
      const goalId = tg.goal_id;
      if (!tasksByGoal.has(goalId)) {
        tasksByGoal.set(goalId, []);
      }
      tasksByGoal.get(goalId).push(tg.tasks);
    });

    // Вычисляем статистику для каждой цели
    const goalsStats = goals.map((goal) => {
      const tasks = tasksByGoal.get(goal.id) || [];
      const totalTasks = tasks.length;
      const completedTasks = tasks.filter((t) => t.is_completed).length;
      const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

      // Задачи, выполненные на этой неделе
      // Используем updated_at для выполненных задач, так как это дата последнего изменения
      const completedThisWeek = tasks.filter((t) => {
        if (!t.is_completed) return false;
        const completionDate = t.updated_at ? new Date(t.updated_at) : (t.created_at ? new Date(t.created_at) : null);
        return completionDate && completionDate >= weekAgo;
      }).length;

      // Задачи, выполненные в этом месяце
      const completedThisMonth = tasks.filter((t) => {
        if (!t.is_completed) return false;
        const completionDate = t.updated_at ? new Date(t.updated_at) : (t.created_at ? new Date(t.created_at) : null);
        return completionDate && completionDate >= monthAgo;
      }).length;

      // Дней до дедлайна
      let daysLeft = null;
      if (goal.deadline) {
        const deadline = new Date(goal.deadline);
        const diffTime = deadline.getTime() - now.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        daysLeft = diffDays > 0 ? diffDays : 0;
      }

      return {
        id: goal.id,
        title: goal.title,
        deadline: goal.deadline,
        totalTasks,
        completedTasks,
        completionRate,
        completedThisWeek,
        completedThisMonth,
        daysLeft,
      };
    });

    // Общая статистика: все выполненные задачи пользователя
    const { count: totalTasksCompleted, error: allTasksError } = await supabaseClient
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('is_completed', true);

    // Количество дней с запланированными задачами (уникальные даты)
    const { data: plannedDays, error: plannedDaysError } = await supabaseClient
      .from('tasks')
      .select('select_date')
      .eq('user_id', user.id)
      .not('select_date', 'is', null);

    const daysPlanned = plannedDaysError
      ? 0
      : new Set((plannedDays || []).map((t) => t.select_date).filter(Boolean)).size;

    const totalCompleted = allTasksError ? 0 : (totalTasksCompleted ?? 0);

    console.log(`✅ Stats calculated: ${goalsStats.length} goals, ${totalCompleted} completed tasks, ${daysPlanned} days planned`);

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          goals: goalsStats,
          summary: {
            totalTasksCompleted: totalCompleted,
            daysPlanned,
          },
        },
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('❌ Error:', error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || 'An unknown error occurred',
        message: 'Failed to fetch planner stats',
      }),
      {
        status: error.message?.includes('not authenticated') ? 401 : 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});

