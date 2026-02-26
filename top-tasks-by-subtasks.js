import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function для получения топ-3 задач с наибольшим количеством подзадач
 * 
 * Возвращает топ-3 задачи пользователя, которые привязаны к целям,
 * отсортированные по количеству подзадач (по убыванию)
 * 
 * Формат ответа:
 * {
 *   success: true,
 *   data: [
 *     {
 *       id: "...",
 *       title: "...",
 *       description: "...",
 *       selectDate: "YYYY-MM-DD",
 *       selectTime: "HH:MM:SS",
 *       repeat: "Weekly",
 *       reminder: "noReminders",
 *       isCompleted: false,
 *       createdAt: "2025-04-01T12:00:00+00:00",
 *       subtasksCount: 5,
 *       subtasksCountCompleted: 3,
 *       tags: [{ id: "...", name: "..." }]
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

    console.log(`📊 Fetching top 3 tasks by subtasks count (with goals) for user: ${user.id}`);

    // Получаем только задачи пользователя, которые привязаны к целям, с подзадачами
    const { data: tasks, error: tasksError } = await supabaseClient
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
        subtasks (
          id,
          title,
          is_completed,
          created_at
        ),
        task_goals!inner (
          goal_id
        )
      `)
      .eq('user_id', user.id);

    if (tasksError) {
      console.error('❌ Error fetching tasks:', tasksError);
      throw new Error(`Failed to fetch tasks: ${tasksError.message}`);
    }

    if (!tasks || tasks.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          data: [],
          message: 'No tasks found',
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Подсчитываем количество подзадач и завершенных подзадач для каждой задачи
    const tasksWithSubtaskCount = tasks.map((task) => {
      const subtasks = task.subtasks || [];
      const subtasksCountCompleted = subtasks.filter(sub => sub.is_completed === true).length;
      return {
        ...task,
        subtasksCount: subtasks.length,
        subtasksCountCompleted,
      };
    });

    // Сортируем по количеству подзадач (по убыванию) и берем топ-3
    const topTasks = tasksWithSubtaskCount
      .sort((a, b) => b.subtasksCount - a.subtasksCount)
      .slice(0, 3);

    // Получаем теги для топ-3 задач
    const taskIds = topTasks.map(t => t.id);
    let tasksWithTags = topTasks;

    if (taskIds.length > 0) {
      const { data: taskTags, error: tagsError } = await supabaseClient
        .from('task_tags')
        .select('task_id, tags:tags_tasks(id, name)')
        .in('task_id', taskIds);

      if (!tagsError && taskTags) {
        const tagsByTask = new Map();
        taskTags.forEach((tt) => {
          if (!tt.tags) return;
          const arr = tagsByTask.get(tt.task_id) || [];
          arr.push({ id: tt.tags.id, name: tt.tags.name });
          tagsByTask.set(tt.task_id, arr);
        });

        tasksWithTags = topTasks.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          selectDate: task.select_date,
          selectTime: task.select_time,
          repeat: task.repeat,
          reminder: task.reminder,
          isCompleted: task.is_completed,
          createdAt: task.created_at,
          subtasksCount: task.subtasksCount,
          subtasksCountCompleted: task.subtasksCountCompleted,
          tags: tagsByTask.get(task.id) || [],
        }));
      } else {
        tasksWithTags = topTasks.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          selectDate: task.select_date,
          selectTime: task.select_time,
          repeat: task.repeat,
          reminder: task.reminder,
          isCompleted: task.is_completed,
          createdAt: task.created_at,
          subtasksCount: task.subtasksCount,
          subtasksCountCompleted: task.subtasksCountCompleted,
          tags: [],
        }));
      }
    }

    console.log(`✅ Found top 3 tasks with goals and subtasks counts: ${tasksWithTags.map(t => `${t.title} (${t.subtasksCount})`).join(', ')}`);

    // Возвращаем результат
    return new Response(
      JSON.stringify({
        success: true,
        data: tasksWithTags,
        message: 'Top 3 tasks with goals by subtasks count retrieved successfully',
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
        message: 'Failed to retrieve top tasks with goals by subtasks count',
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

