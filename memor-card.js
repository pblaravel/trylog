import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function: memor-card
 * 
 * Ищет журналы пользователя по самым часто используемым тегам среди записей,
 * созданных старше чем N дней назад (по умолчанию 30), и возвращает
 * эти журналы с полным набором данных в формате как в journal-by-id.js.
 * 
 * Query params (GET) или JSON body (POST):
 * - days: число дней давности, default 30
 * - top_k: количество топ-тегов, default 3
 * - limit: максимальное число возвращаемых журналов, default 20
 */

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // Auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Missing authorization token');
    }

    // Params
    const url = new URL(req.url);
    let days = 30;
    let topK = 3;
    let limit = 20;

    if (req.method === 'GET') {
      days = Number(url.searchParams.get('days') ?? days) || days;
      topK = Number(url.searchParams.get('top_k') ?? topK) || topK;
      limit = Number(url.searchParams.get('limit') ?? limit) || limit;
    } else if (req.method === 'POST') {
      try {
        const body = await req.json();
        if (typeof body.days === 'number') days = body.days;
        if (typeof body.top_k === 'number') topK = body.top_k;
        if (typeof body.limit === 'number') limit = body.limit;
      } catch {
        // ignore, use defaults
      }
    } else {
      return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - Math.max(0, days));
    const cutoffISO = cutoff.toISOString();

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, detectSessionInUrl: false },
      }
    );

    // Verify user
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      throw new Error('User not authenticated');
    }

    // 1) Собираем частоту использования тегов среди журналов старше cutoff
    // Берем связи journal_tag с inner join на journal для фильтрации по пользователю и дате
    const { data: jtRows, error: jtError } = await supabase
      .from('journal_tag')
      .select(`
        tag_id,
        tags ( id, name ),
        journal!inner ( id, user_id, created_at )
      `)
      .eq('journal.user_id', user.id)
      .lte('journal.created_at', cutoffISO);

    if (jtError) {
      console.error('Error fetching journal_tag:', jtError);
      throw new Error(`Failed to fetch tags: ${jtError.message}`);
    }

    const tagCountMap = new Map(); // tag_id -> { id, name, count }
    for (const row of jtRows ?? []) {
      const tagId = row.tag_id;
      const tagName = row.tags?.name ?? null;
      if (!tagId || !tagName) continue;
      const current = tagCountMap.get(tagId) || { id: tagId, name: tagName, count: 0 };
      current.count += 1;
      tagCountMap.set(tagId, current);
    }

    const topTags = Array.from(tagCountMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, Math.max(1, topK));

    if (topTags.length === 0) {
      return new Response(JSON.stringify({ success: true, data: [], message: 'No tags found older than cutoff' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const topTagIds = topTags.map(t => t.id);

    // 2) Находим журналы пользователя старше cutoff, у которых есть любой из topTagIds
    const { data: jIdsRows, error: jIdsError } = await supabase
      .from('journal_tag')
      .select(`
        journal_id,
        journal!inner ( id, user_id, created_at )
      `)
      .in('tag_id', topTagIds)
      .eq('journal.user_id', user.id)
      .lte('journal.created_at', cutoffISO);

    if (jIdsError) {
      console.error('Error fetching journal ids:', jIdsError);
      throw new Error(`Failed to fetch journals: ${jIdsError.message}`);
    }

    const journalIdSet = new Set();
    for (const row of jIdsRows ?? []) {
      if (row.journal_id) journalIdSet.add(row.journal_id);
    }

    let journalIds = Array.from(journalIdSet);
    if (journalIds.length === 0) {
      return new Response(JSON.stringify({ success: true, data: [], message: 'No journals matched top tags' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3) Получаем полные данные по журналам, как в journal-by-id.js, пачкой
    // Сначала получим заголовки и сортировку, чтобы ограничить limit по дате
    const { data: baseJournals, error: baseErr } = await supabase
      .from('journal')
      .select('id, user_id, title, description, title_image, created_at, is_favorite')
      .in('id', journalIds)
      .eq('user_id', user.id)
      .lte('created_at', cutoffISO)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (baseErr) {
      console.error('Error fetching journals base:', baseErr);
      throw new Error(`Failed to fetch journals: ${baseErr.message}`);
    }

    journalIds = (baseJournals ?? []).map(j => j.id);
    if (journalIds.length === 0) {
      return new Response(JSON.stringify({ success: true, data: [], message: 'No journals within limit' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Параллельно подтянем связанные сущности
    const [imagesRes, audioRes, tagsRes, locRes] = await Promise.all([
      supabase.from('journal_image').select('id, url, created_at, journal_id').in('journal_id', journalIds).order('created_at', { ascending: true }),
      supabase.from('journal_audio').select('id, url, created_at, journal_id').in('journal_id', journalIds).order('created_at', { ascending: true }),
      supabase.from('journal_tag').select('journal_id, tags(id, name)').in('journal_id', journalIds),
      supabase.from('journal_location').select('journal_id, locations(id, city, state)').in('journal_id', journalIds),
    ]);

    if (imagesRes.error) console.error('Error fetching images:', imagesRes.error);
    if (audioRes.error) console.error('Error fetching audio:', audioRes.error);
    if (tagsRes.error) console.error('Error fetching tags:', tagsRes.error);
    if (locRes.error) console.error('Error fetching locations:', locRes.error);

    const imagesByJournal = new Map();
    for (const img of imagesRes.data ?? []) {
      const arr = imagesByJournal.get(img.journal_id) || [];
      arr.push({ id: img.id, url: img.url, createdAt: img.created_at });
      imagesByJournal.set(img.journal_id, arr);
    }

    const audioByJournal = new Map();
    for (const aud of audioRes.data ?? []) {
      const arr = audioByJournal.get(aud.journal_id) || [];
      arr.push({ id: aud.id, url: aud.url, createdAt: aud.created_at });
      audioByJournal.set(aud.journal_id, arr);
    }

    const tagsByJournal = new Map();
    for (const row of tagsRes.data ?? []) {
      const arr = tagsByJournal.get(row.journal_id) || [];
      if (row.tags) arr.push({ id: row.tags.id, name: row.tags.name });
      tagsByJournal.set(row.journal_id, arr);
    }

    const locationByJournal = new Map();
    for (const row of locRes.data ?? []) {
      if (row.locations) {
        locationByJournal.set(row.journal_id, {
          id: row.locations.id,
          city: row.locations.city,
          state: row.locations.state,
        });
      }
    }

    const result = (baseJournals ?? []).map(j => {
      const images = imagesByJournal.get(j.id) || [];
      const audio = audioByJournal.get(j.id) || [];
      const tags = tagsByJournal.get(j.id) || [];
      const location = locationByJournal.get(j.id) || null;
      return {
        id: j.id,
        title: j.title,
        description: j.description,
        tags,
        countMedia: images.length + audio.length,
        location,
        titleImage: j.title_image,
        createdAt: j.created_at,
        isFavorite: j.is_favorite,
        images,
        audio,
      };
    });

    return new Response(
      JSON.stringify({
        success: true,
        data: result,
        meta: {
          cutoff: cutoffISO,
          topTags: topTags.map(t => ({ id: t.id, name: t.name, count: t.count })),
        },
        message: 'Journals by frequent older tags retrieved successfully',
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    console.error('❌ Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message || 'An unknown error occurred', message: 'Failed to retrieve journals' }),
      { status: error.message?.includes('not authenticated') ? 401 : 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});



