import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function for retrieving a task by ID
 * 
 * Returns complete task data including:
 * - Basic task information (title, description, select_date, select_time, repeat, is_completed)
 * - Images (task_image)
 * - Audio files (task_audio)
 * - Tags (tags via task_tags)
 * - Subtasks (subtasks)
 * - Goals (goals via task_goals, optional)
 * 
 * Usage:
 * GET /get-task-by-id?id={task_id}
 */

Deno.serve(async (req) => {
  // Handle CORS preflight request
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  try {
    // Create Supabase client with user token
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

    // Verify user authentication
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      throw new Error('User not authenticated');
    }

    // Get task ID from query params
    const url = new URL(req.url);
    const taskId = url.searchParams.get('id');

    if (!taskId || taskId.trim() === '') {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Task ID is required',
          message: 'Please provide a task ID in the query parameter: ?id={task_id}',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    console.log(`📋 Fetching task ${taskId} for user: ${user.id}`);

    // 1. Fetch main task entry
    const { data: task, error: taskError } = await supabaseClient
      .from('tasks')
      .select('id, user_id, title, description, select_date, select_time, repeat, reminder, is_completed, created_at')
      .eq('id', taskId)
      .eq('user_id', user.id)
      .single();

    if (taskError) {
      if (taskError.code === 'PGRST116') {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Task not found',
            message: 'The requested task does not exist or you do not have access to it',
          }),
          {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }
      console.error('❌ Error fetching task:', taskError);
      throw new Error(`Failed to fetch task: ${taskError.message}`);
    }

    console.log(`✅ Task found: ${task.title}`);

    // 2. Fetch images
    const { data: images, error: imagesError } = await supabaseClient
      .from('task_image')
      .select('id, url, created_at')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true });

    if (imagesError) {
      console.error('⚠️ Error fetching images:', imagesError);
    }

    // 3. Fetch audio files
    const { data: audio, error: audioError } = await supabaseClient
      .from('task_audio')
      .select('id, url, created_at')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true });

    if (audioError) {
      console.error('⚠️ Error fetching audio:', audioError);
    }

    // 4. Fetch tags
    const { data: taskTags, error: tagsError } = await supabaseClient
      .from('task_tags')
      .select('tag_id, tags:tags_tasks(id, name)')
      .eq('task_id', taskId);

    let tags = [];
    if (tagsError) {
      console.error('⚠️ Error fetching tags:', tagsError);
    } else if (taskTags) {
      tags = taskTags
        .filter((tt) => tt.tags)
        .map((tt) => ({
          id: tt.tags.id,
          name: tt.tags.name,
        }));
    }

    // 5. Fetch subtasks
    const { data: subtasks, error: subtasksError } = await supabaseClient
      .from('subtasks')
      .select('id, title, is_completed, created_at')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true });

    if (subtasksError) {
      console.error('⚠️ Error fetching subtasks:', subtasksError);
    }

    // 6. Fetch goals (optional)
    const { data: taskGoals, error: goalsError } = await supabaseClient
      .from('task_goals')
      .select('goal_id, goals(id, title, deadline, created_at)')
      .eq('task_id', taskId);

    let goals = [];
    if (goalsError) {
      console.error('⚠️ Error fetching goals:', goalsError);
    } else if (taskGoals && taskGoals.length > 0) {
      const goalIds = taskGoals.filter((tg) => tg.goals).map((tg) => tg.goals.id);

      // Получаем все таски для этих целей
      const { data: allTaskGoals, error: allTaskGoalsError } = await supabaseClient
        .from('task_goals')
        .select('goal_id, tasks:tasks!inner(id, is_completed)')
        .in('goal_id', goalIds)
        .eq('tasks.user_id', user.id);

      if (allTaskGoalsError) {
        console.error('⚠️ Error fetching all task-goals:', allTaskGoalsError);
      }

      // Группируем задачи по целям
      const tasksByGoal = new Map();
      const allTaskIds = new Set();
      (allTaskGoals || []).forEach((tg) => {
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
        const { data: allSubtasks, error: subtasksError } = await supabaseClient
          .from('subtasks')
          .select('id, task_id, is_completed')
          .in('task_id', taskIdsArray)
          .eq('user_id', user.id);

        if (subtasksError) {
          console.error('⚠️ Error fetching subtasks for goals:', subtasksError);
        } else if (allSubtasks) {
          allSubtasks.forEach((subtask) => {
            const taskId = subtask.task_id;
            if (!subtasksByTask.has(taskId)) {
              subtasksByTask.set(taskId, []);
            }
            subtasksByTask.get(taskId).push(subtask);
          });
        }
      }

      // Формируем goals с completionPercentage
      goals = taskGoals
        .filter((tg) => tg.goals)
        .map((tg) => {
          const goal = tg.goals;
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

          // Вычисляем процент выполнения
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
    }

    console.log(`📊 Data fetched: ${images?.length || 0} images, ${audio?.length || 0} audio, ${tags.length} tags, ${subtasks?.length || 0} subtasks, ${goals.length} goals`);

    // Build complete response in the same format as task-pagination
    const result = {
      id: task.id,
      title: task.title,
      description: task.description,
      selectDate: task.select_date,
      selectTime: task.select_time,
      repeat: task.repeat,
      reminder: task.reminder,
      isCompleted: task.is_completed,
      createdAt: task.created_at,
      tags: tags,
      subtasks: (subtasks || []).map((sub) => ({
        id: sub.id,
        title: sub.title,
        isCompleted: sub.is_completed,
        createdAt: sub.created_at,
      })),
      images: (images || []).map((img) => ({
        id: img.id,
        url: img.url,
        createdAt: img.created_at,
      })),
      audio: (audio || []).map((aud) => ({
        id: aud.id,
        url: aud.url,
        createdAt: aud.created_at,
      })),
      goals: goals,
      countMedia: (images?.length || 0) + (audio?.length || 0),
    };

    console.log('🎉 Task data retrieved successfully!');

    // Return result
    return new Response(
      JSON.stringify({
        success: true,
        data: result,
        message: 'Task retrieved successfully',
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
        message: 'Failed to retrieve task',
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

