import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function для подсчета streaks (последовательностей) для задач
 * 
 * Возвращает:
 * - daily_streaks: количество дней подряд с выполненными задачами (начиная с сегодня)
 * - weekly_streaks: количество недель (daily_streaks / 7)
 * - longest_daily_streak: самая длинная ежедневная серия
 * - longest_weekly_streak: самая длинная недельная серия
 * 
 * Логика:
 * - Если сегодня есть выполненная задача - streak = 1
 * - Если вчера тоже есть - streak = 2
 * - Продолжаем пока не найдем день без выполненных задач
 * - Для longest считаем все серии в истории
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

    console.log(`🔥 Calculating task streaks for user: ${user.id}`);

    // Получаем все выполненные задачи пользователя
    const { data: completedTasks, error: tasksError } = await supabaseClient
      .from('tasks')
      .select('id, is_completed, updated_at, created_at')
      .eq('user_id', user.id)
      .eq('is_completed', true)
      .order('updated_at', { ascending: false });

    if (tasksError) {
      console.error('❌ Error fetching tasks:', tasksError);
      throw new Error(`Failed to fetch tasks: ${tasksError.message}`);
    }

    console.log(`✅ Found ${completedTasks?.length || 0} completed tasks`);

    // Инициализация результата
    let daily_streaks = 0;
    let weekly_streaks = 0;
    let longest_daily_streak = 0;
    let longest_weekly_streak = 0;

    if (!completedTasks || completedTasks.length === 0) {
      console.log('📭 No completed tasks found, streaks = 0');
      
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            daily_streaks,
            weekly_streaks,
            longest_daily_streak,
            longest_weekly_streak,
          },
          message: 'No completed tasks found, streaks are zero',
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

    // Функция для форматирования даты в YYYY-MM-DD
    const formatDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    // Создаем Set с уникальными датами выполнения (используем updated_at для выполненных задач)
    const uniqueDates = new Set();
    for (const task of completedTasks) {
      const dateStr = task.updated_at 
        ? task.updated_at.split('T')[0]
        : (task.created_at ? task.created_at.split('T')[0] : null);
      if (dateStr) {
        uniqueDates.add(dateStr);
      }
    }

    console.log(`📅 Unique dates with completed tasks: ${uniqueDates.size}`);

    // Получаем текущую дату (сегодня)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = formatDate(today);
    
    // Определяем стартовую дату для подсчета текущего streak
    // Если сегодня есть выполненная задача - начинаем с сегодня, если нет - со вчера
    let currentDate;
    if (uniqueDates.has(todayStr)) {
      // Сегодня есть выполненная задача - начинаем с сегодня
      currentDate = new Date(today);
      console.log(`📅 Starting streak from today (${todayStr}) - task completed`);
    } else {
      // Сегодня нет выполненной задачи - начинаем со вчера
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      currentDate = new Date(yesterday);
      console.log(`📅 Starting streak from yesterday - no task completed today yet`);
    }
    
    // Подсчитываем текущий streak
    while (true) {
      const dateStr = formatDate(currentDate);
      
      if (uniqueDates.has(dateStr)) {
        // Нашли выполненную задачу за этот день
        daily_streaks++;
        console.log(`✅ Day ${daily_streaks}: ${dateStr} - task completed`);
        
        // Переходим к предыдущему дню
        currentDate.setDate(currentDate.getDate() - 1);
      } else {
        // День без выполненных задач - прерываем streak
        console.log(`❌ No completed task found for ${dateStr} - streak broken`);
        break;
      }
    }

    // Вычисляем weekly_streaks (количество полных недель)
    weekly_streaks = Math.floor(daily_streaks / 7);
    if (daily_streaks !== 0 && weekly_streaks === 0) {
      weekly_streaks = 1;
    }

    // Подсчитываем самую длинную серию (longest streak)
    // Сортируем все даты по возрастанию
    const sortedDates = Array.from(uniqueDates).sort();
    
    if (sortedDates.length > 0) {
      let maxDailyStreak = 1;
      let currentStreak = 1;
      
      // Проходим по отсортированным датам и ищем самую длинную последовательность
      for (let i = 1; i < sortedDates.length; i++) {
        const prevDate = new Date(sortedDates[i - 1]);
        const currDate = new Date(sortedDates[i]);
        
        // Вычисляем разницу в днях
        const diffTime = currDate.getTime() - prevDate.getTime();
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        
        if (diffDays === 1) {
          // Следующий день - продолжаем streak
          currentStreak++;
        } else {
          // Разрыв в streak - обновляем максимум и сбрасываем
          if (currentStreak > maxDailyStreak) {
            maxDailyStreak = currentStreak;
          }
          currentStreak = 1;
        }
      }
      
      // Проверяем последний streak
      if (currentStreak > maxDailyStreak) {
        maxDailyStreak = currentStreak;
      }
      
      longest_daily_streak = maxDailyStreak;
      longest_weekly_streak = Math.floor(longest_daily_streak / 7);
      if (longest_daily_streak > 0 && longest_weekly_streak === 0) {
        longest_weekly_streak = 1;
      }
    }

    console.log(`🔥 Streaks calculated:`);
    console.log(`   - Daily streaks: ${daily_streaks}`);
    console.log(`   - Weekly streaks: ${weekly_streaks}`);
    console.log(`   - Longest daily streak: ${longest_daily_streak}`);
    console.log(`   - Longest weekly streak: ${longest_weekly_streak}`);

    // Возвращаем результат
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          daily_streaks,
          weekly_streaks,
          longest_daily_streak,
          longest_weekly_streak,
        },
        message: 'Task streaks calculated successfully',
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
        message: 'Failed to calculate task streaks',
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

