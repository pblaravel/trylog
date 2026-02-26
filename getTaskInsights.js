import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function для получения статистики по задачам
 * 
 * Возвращает:
 * - thisYear: { total, completed, percentage }
 * - thisMonth: { total, completed, percentage }
 * - thisWeek: { total, completed, percentage }
 * - taskCompletionRate: общий процент выполнения всех задач
 * - perfectDays: количество дней, когда все задачи были выполнены
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

    console.log(`📊 Fetching task insights for user: ${user.id}`);

    // Вычисляем даты для фильтрации
    const now = new Date();
    
    // Текущий год (1 января текущего года)
    const currentYearStart = new Date(now.getFullYear(), 0, 1);
    const currentYearStartISO = currentYearStart.toISOString();
    
    // Текущий месяц (1 число текущего месяца)
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const currentMonthStartISO = currentMonthStart.toISOString();
    
    // Текущая неделя (понедельник текущей недели)
    const currentWeekStart = new Date(now);
    const dayOfWeek = now.getDay();
    const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Понедельник
    currentWeekStart.setDate(diff);
    currentWeekStart.setHours(0, 0, 0, 0);
    const currentWeekStartISO = currentWeekStart.toISOString();

    console.log(`📅 Periods - Year from: ${currentYearStartISO}, Month from: ${currentMonthStartISO}, Week from: ${currentWeekStartISO}`);

    // Получаем все задачи пользователя
    const { data: allTasks, error: tasksError } = await supabaseClient
      .from('tasks')
      .select('id, is_completed, created_at, updated_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (tasksError) {
      console.error('❌ Error fetching tasks:', tasksError);
      throw new Error(`Failed to fetch tasks: ${tasksError.message}`);
    }

    console.log(`✅ Found ${allTasks?.length || 0} total tasks`);

    // Инициализация результатов
    const insights = {
      thisYear: { total: 0, completed: 0, percentage: 0 },
      thisMonth: { total: 0, completed: 0, percentage: 0 },
      thisWeek: { total: 0, completed: 0, percentage: 0 },
      taskCompletionRate: 0,
      perfectDays: 0,
    };

    if (!allTasks || allTasks.length === 0) {
      console.log('📭 No tasks found for statistics');
      return new Response(
        JSON.stringify({
          success: true,
          data: insights,
          message: 'No tasks found',
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    // Фильтруем задачи по периодам
    const tasksThisYear = allTasks.filter(t => 
      new Date(t.created_at) >= currentYearStart
    );
    
    const tasksThisMonth = allTasks.filter(t => 
      new Date(t.created_at) >= currentMonthStart
    );
    
    const tasksThisWeek = allTasks.filter(t => 
      new Date(t.created_at) >= currentWeekStart
    );

    // Подсчитываем статистику для каждого периода
    insights.thisYear.total = tasksThisYear.length;
    insights.thisYear.completed = tasksThisYear.filter(t => t.is_completed).length;
    insights.thisYear.percentage = insights.thisYear.total > 0 
      ? Math.round((insights.thisYear.completed / insights.thisYear.total) * 100)
      : 0;

    insights.thisMonth.total = tasksThisMonth.length;
    insights.thisMonth.completed = tasksThisMonth.filter(t => t.is_completed).length;
    insights.thisMonth.percentage = insights.thisMonth.total > 0 
      ? Math.round((insights.thisMonth.completed / insights.thisMonth.total) * 100)
      : 0;

    insights.thisWeek.total = tasksThisWeek.length;
    insights.thisWeek.completed = tasksThisWeek.filter(t => t.is_completed).length;
    insights.thisWeek.percentage = insights.thisWeek.total > 0 
      ? Math.round((insights.thisWeek.completed / insights.thisWeek.total) * 100)
      : 0;

    // Общий процент выполнения всех задач
    const totalCompleted = allTasks.filter(t => t.is_completed).length;
    insights.taskCompletionRate = allTasks.length > 0 
      ? Math.round((totalCompleted / allTasks.length) * 100)
      : 0;

    // Подсчитываем Perfect Days (дни, когда все задачи были выполнены)
    // Группируем задачи по датам создания
    const tasksByDate = new Map();
    for (const task of allTasks) {
      const dateStr = task.created_at.split('T')[0];
      if (!tasksByDate.has(dateStr)) {
        tasksByDate.set(dateStr, []);
      }
      tasksByDate.get(dateStr).push(task);
    }

    let perfectDaysCount = 0;
    for (const [dateStr, tasks] of tasksByDate.entries()) {
      // Проверяем, все ли задачи за этот день выполнены
      const allCompleted = tasks.every(t => t.is_completed);
      if (allCompleted && tasks.length > 0) {
        perfectDaysCount++;
      }
    }
    insights.perfectDays = perfectDaysCount;

    console.log(`📈 Task insights calculated:`);
    console.log(`   This Year: ${insights.thisYear.completed}/${insights.thisYear.total} (${insights.thisYear.percentage}%)`);
    console.log(`   This Month: ${insights.thisMonth.completed}/${insights.thisMonth.total} (${insights.thisMonth.percentage}%)`);
    console.log(`   This Week: ${insights.thisWeek.completed}/${insights.thisWeek.total} (${insights.thisWeek.percentage}%)`);
    console.log(`   Completion Rate: ${insights.taskCompletionRate}%`);
    console.log(`   Perfect Days: ${insights.perfectDays}`);

    // Возвращаем результат
    return new Response(
      JSON.stringify({
        success: true,
        data: insights,
        message: 'Task insights retrieved successfully',
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
        message: 'Failed to retrieve task insights',
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


