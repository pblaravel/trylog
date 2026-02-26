import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function для получения статистики по тегам задач
 * 
 * Возвращает:
 * - tags: массив тегов с количеством использований
 * - combinations: массив комбинаций тегов (пар) с количеством использований
 * 
 * Формат ответа:
 * {
 *   tags: [
 *     { name: "Productivity", count: 12, id: 1 },
 *     { name: "Work", count: 8, id: 2 }
 *   ],
 *   combinations: [
 *     { name: "Productivity & Work", count: 5, ids: [1, 2] },
 *     { name: "Routine & Productivity", count: 3, ids: [3, 1] }
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

    console.log(`📊 Getting task tags statistics for user: ${user.id}`);

    // 1. Получаем все задачи пользователя с их тегами
    const { data: tasksWithTags, error: tasksError } = await supabaseClient
      .from('tasks')
      .select(`
        id,
        task_tags (
          tag_id,
          tags_tasks (
            id,
            name
          )
        )
      `)
      .eq('user_id', user.id);

    if (tasksError) {
      console.error('❌ Error fetching tasks with tags:', tasksError);
      throw new Error(`Failed to fetch tasks: ${tasksError.message}`);
    }

    console.log(`✅ Found ${tasksWithTags?.length || 0} tasks with tags`);

    // 2. Подсчитываем использование отдельных тегов
    const tagCounts = new Map(); // tagId -> { id, name, count }
    const taskTagCombinations = new Map(); // "id1:id2" -> { ids: [id1, id2], name: "A & B", count }

    for (const task of tasksWithTags || []) {
      const taskTags = task.task_tags || [];
      
      // Фильтруем только валидные теги
      const validTags = taskTags
        .filter(tt => tt.tags_tasks)
        .map(tt => ({
          id: tt.tags_tasks.id,
          name: tt.tags_tasks.name
        }));

      // Подсчитываем отдельные теги
      for (const tag of validTags) {
        const current = tagCounts.get(tag.id) || { id: tag.id, name: tag.name, count: 0 };
        current.count += 1;
        tagCounts.set(tag.id, current);
      }

      // Подсчитываем комбинации тегов (пары)
      if (validTags.length >= 2) {
        // Сортируем теги по id для консистентности ключа
        const sortedTags = validTags
          .slice()
          .sort((a, b) => String(a.id).localeCompare(String(b.id)));
        
        // Создаем все возможные пары
        for (let i = 0; i < sortedTags.length; i++) {
          for (let j = i + 1; j < sortedTags.length; j++) {
            const tag1 = sortedTags[i];
            const tag2 = sortedTags[j];
            const key = `${tag1.id}:${tag2.id}`;
            const combinationName = `${tag1.name} & ${tag2.name}`;
            const current = taskTagCombinations.get(key) || {
              ids: [tag1.id, tag2.id],
              name: combinationName,
              count: 0
            };
            current.count += 1;
            taskTagCombinations.set(key, current);
          }
        }
      }
    }

    // 3. Формируем результат для отдельных тегов
    const tags = Array.from(tagCounts.values())
      .sort((a, b) => b.count - a.count); // Сортируем по убыванию количества

    // 4. Формируем результат для комбинаций тегов
    const combinations = Array.from(taskTagCombinations.values())
      .sort((a, b) => b.count - a.count); // Сортируем по убыванию количества

    console.log(`📈 Task tags statistics calculated:`);
    console.log(`   - Unique tags: ${tags.length}`);
    console.log(`   - Tag combinations: ${combinations.length}`);

    // Возвращаем результат
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          tags,
          combinations,
        },
        message: 'Task tags statistics retrieved successfully',
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
        message: 'Failed to retrieve task tags statistics',
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


