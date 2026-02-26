import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function для получения всех целей, отсортированных по количеству подзадач
 * 
 * Возвращает все цели пользователя, отсортированные по общему количеству подзадач
 * во всех связанных задачах (по убыванию)
 * 
 * Формат ответа:
 * {
 *   success: true,
 *   data: [
 *     {
 *       id: "...",
 *       title: "...",
 *       deadline: "YYYY-MM-DD",
 *       createdAt: "2025-04-01T12:00:00+00:00",
 *       subtasksCount: 15,
 *       subtasksCountCompleted: 10,
 *       completionPercentage: 75
 *     }
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

    console.log(`📊 Fetching all goals sorted by subtasks count for user: ${user.id}`);

    // Получаем все цели пользователя
    const { data: goals, error: goalsError } = await supabaseClient
      .from('goals')
      .select('id, title, deadline, created_at')
      .eq('user_id', user.id);

    if (goalsError) {
      console.error('❌ Error fetching goals:', goalsError);
      throw new Error(`Failed to fetch goals: ${goalsError.message}`);
    }

    if (!goals || goals.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          data: [],
          message: 'No goals found',
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const goalIds = goals.map(g => g.id);

    // Получаем все задачи, прикрепленные к этим целям
    const { data: taskGoals, error: taskGoalsError } = await supabaseClient
      .from('task_goals')
      .select('goal_id, tasks:tasks!inner(id, is_completed)')
      .in('goal_id', goalIds)
      .eq('tasks.user_id', user.id);

    if (taskGoalsError) {
      console.error('❌ Error fetching task-goals:', taskGoalsError);
      throw new Error(`Failed to fetch task-goals: ${taskGoalsError.message}`);
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
      const { data: subtasks, error: subtasksError } = await supabaseClient
        .from('subtasks')
        .select('id, task_id, is_completed')
        .in('task_id', taskIdsArray)
        .eq('user_id', user.id);

      if (subtasksError) {
        console.error('❌ Error fetching subtasks:', subtasksError);
        throw new Error(`Failed to fetch subtasks: ${subtasksError.message}`);
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

    // Подсчитываем количество подзадач и завершенных подзадач для каждой цели
    const goalsWithSubtaskCount = goals.map((goal) => {
      const tasks = tasksByGoal.get(goal.id) || [];
      
      // Подсчитываем все подзадачи для этой цели
      let subtasksCount = 0;
      let subtasksCountCompleted = 0;
      
      tasks.forEach((task) => {
        const taskSubtasks = subtasksByTask.get(task.id) || [];
        subtasksCount += taskSubtasks.length;
        subtasksCountCompleted += taskSubtasks.filter(st => st.is_completed === true).length;
      });

      // Вычисляем процент выполнения (с учетом тасков и subtasks)
      let totalItems = tasks.length + subtasksCount;
      let completedItems = tasks.filter((t) => t.is_completed).length + subtasksCountCompleted;
      
      let completionPercentage = 100;
      const incompleteItems = totalItems - completedItems;
      if (totalItems > 0 && incompleteItems > 0) {
        completionPercentage = Math.round((completedItems / totalItems) * 100);
      }

      return {
        ...goal,
        subtasksCount,
        subtasksCountCompleted,
        completionPercentage,
      };
    });

    // Сортируем по количеству подзадач (по убыванию)
    const sortedGoals = goalsWithSubtaskCount
      .sort((a, b) => b.subtasksCount - a.subtasksCount);

    // Форматируем результат
    const formattedGoals = sortedGoals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      deadline: goal.deadline,
      createdAt: goal.created_at,
      subtasksCount: goal.subtasksCount,
      subtasksCountCompleted: goal.subtasksCountCompleted,
      completionPercentage: goal.completionPercentage,
    }));

    console.log(`✅ Found ${formattedGoals.length} goals sorted by subtasks counts`);

    // Возвращаем результат
    return new Response(
      JSON.stringify({
        success: true,
        data: formattedGoals,
        message: 'All goals sorted by subtasks count retrieved successfully',
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
        message: 'Failed to retrieve goals sorted by subtasks count',
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

