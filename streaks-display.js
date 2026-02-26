import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function для подсчета streaks (последовательностей)
 * 
 * Возвращает:
 * - daily_streaks: количество дней подряд с созданными журналами (начиная с сегодня)
 * - weekly_streaks: количество недель (daily_streaks / 7)
 * 
 * Логика:
 * - Если сегодня есть журнал - streak = 1
 * - Если вчера тоже есть - streak = 2
 * - Продолжаем пока не найдем день без журналов
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

    console.log(`🔥 Calculating streaks for user: ${user.id}`);

    // Получаем все журналы пользователя, отсортированные по дате создания
    const { data: journals, error: journalsError } = await supabaseClient
      .from('journal')
      .select('id, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (journalsError) {
      console.error('❌ Error fetching journals:', journalsError);
      throw new Error(`Failed to fetch journals: ${journalsError.message}`);
    }

    console.log(`✅ Found ${journals?.length || 0} total journals`);

    // Инициализация результата
    let daily_streaks = 0;
    let weekly_streaks = 0;

    if (!journals || journals.length === 0) {
      console.log('📭 No journals found, streaks = 0');
      
      // Функция для форматирования даты в YYYY-MM-DD
      const formatDate = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      };
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            daily_streaks,
            weekly_streaks,
          },
          message: 'No journals found, streaks are zero',
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

    // Создаем Set с уникальными датами (только даты, без времени)
    const uniqueDates = new Set();
    for (const journal of journals) {
      if (journal.created_at) {
        // Извлекаем только дату в формате YYYY-MM-DD
        const dateOnly = journal.created_at.split('T')[0];
        uniqueDates.add(dateOnly);
      }
    }

    console.log(`📅 Unique dates with journals: ${uniqueDates.size}`);

    // Функция для форматирования даты в YYYY-MM-DD
    const formatDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    // Получаем текущую дату (сегодня)
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Сбрасываем время
    
    const todayStr = formatDate(today);
    
    // Определяем стартовую дату для подсчета streak
    // Если сегодня есть журнал - начинаем с сегодня, если нет - со вчера
    let currentDate;
    if (uniqueDates.has(todayStr)) {
      // Сегодня есть журнал - начинаем с сегодня
      currentDate = new Date(today);
      console.log(`📅 Starting streak from today (${todayStr}) - journal exists`);
    } else {
      // Сегодня нет журнала - начинаем со вчера
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      currentDate = new Date(yesterday);
      console.log(`📅 Starting streak from yesterday - no journal today yet`);
    }
    
    while (true) {
      const dateStr = formatDate(currentDate);
      
      if (uniqueDates.has(dateStr)) {
        // Нашли журнал за этот день
        daily_streaks++;
        console.log(`✅ Day ${daily_streaks}: ${dateStr} - journal found`);
        
        // Переходим к предыдущему дню
        currentDate.setDate(currentDate.getDate() - 1);
      } else {
        // День без журнала - прерываем streak
        console.log(`❌ No journal found for ${dateStr} - streak broken`);
        break;
      }
    }

    // Вычисляем weekly_streaks (количество полных недель)
    weekly_streaks = Math.floor(daily_streaks / 7);

    console.log(`🔥 Streaks calculated:`);
    console.log(`   - Daily streaks: ${daily_streaks}`);
    console.log(`   - Weekly streaks: ${weekly_streaks}`);


    if (daily_streaks !== 0 && weekly_streaks === 0) {
      weekly_streaks = 1;
    }
    // Возвращаем результат
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          daily_streaks,
          weekly_streaks,
        },
        message: 'Streaks calculated successfully',
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
        message: 'Failed to calculate streaks',
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

