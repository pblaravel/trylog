import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function для получения статистики по тегам
 * 
 * Возвращает:
 * - tags: массив тегов с количеством использований
 * - combinations: массив комбинаций тегов (пар) с количеством использований
 * 
 * Формат ответа:
 * {
 *   tags: [
 *     { name: "Grow", count: 3, id: 1 },
 *     { name: "Career", count: 2, id: 2 }
 *   ],
 *   combinations: [
 *     { name: "Career & Progress", count: 2, ids: [2, 3] },
 *     { name: "Grow & Learning", count: 1, ids: [1, 4] }
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

    console.log(`📊 Getting tags statistics for user: ${user.id}`);

    // 1. Получаем все журналы пользователя с их тегами
    const { data: journalsWithTags, error: journalsError } = await supabaseClient
      .from('journal')
      .select(`
        id,
        journal_tag (
          tag_id,
          tags (
            id,
            name
          )
        )
      `)
      .eq('user_id', user.id);

    if (journalsError) {
      console.error('❌ Error fetching journals with tags:', journalsError);
      throw new Error(`Failed to fetch journals: ${journalsError.message}`);
    }

    console.log(`✅ Found ${journalsWithTags?.length || 0} journals with tags`);

    // 2. Подсчитываем использование отдельных тегов
    const tagCounts = new Map(); // tagId -> { id, name, count }
    const journalTagCombinations = new Map(); // "id1:id2" -> { ids: [id1, id2], name: "A & B", count }

    for (const journal of journalsWithTags || []) {
      const journalTags = journal.journal_tag || [];
      
      // Фильтруем только валидные теги
      const validTags = journalTags
        .filter(jt => jt.tags)
        .map(jt => ({
          id: jt.tags.id,
          name: jt.tags.name
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
            const current = journalTagCombinations.get(key) || {
              ids: [tag1.id, tag2.id],
              name: combinationName,
              count: 0
            };
            current.count += 1;
            journalTagCombinations.set(key, current);
          }
        }
      }
    }

    // 3. Формируем результат для отдельных тегов
    const tags = Array.from(tagCounts.values())
      .sort((a, b) => b.count - a.count); // Сортируем по убыванию количества

    // 4. Формируем результат для комбинаций тегов
    const combinations = Array.from(journalTagCombinations.values())
      .sort((a, b) => b.count - a.count); // Сортируем по убыванию количества

    console.log(`📈 Statistics calculated:`);
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
        message: 'Tags statistics retrieved successfully',
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
        message: 'Failed to retrieve tags statistics',
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
