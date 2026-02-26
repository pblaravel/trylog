import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function: getTaskSuccessCard
 * 
 * Ищет задачи пользователя по самым часто используемым тегам среди задач,
 * созданных старше чем N дней назад (по умолчанию 30), и возвращает
 * эти задачи с полным набором данных в формате как в get-task-by-id.js.
 * 
 * Query params (GET) или JSON body (POST):
 * - days: число дней давности, default 30
 * - top_k: количество топ-тегов, default 3
 * - limit: максимальное число возвращаемых задач, default 20
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

    // 1) Собираем частоту использования тегов среди задач старше cutoff
    // Берем связи task_tags с inner join на tasks для фильтрации по пользователю и дате
    const { data: ttRows, error: ttError } = await supabase
      .from('task_tags')
      .select(`
        tag_id,
        tags_tasks ( id, name ),
        tasks!inner ( id, user_id, created_at )
      `)
      .eq('tasks.user_id', user.id)
      .lte('tasks.created_at', cutoffISO);

    if (ttError) {
      console.error('Error fetching task_tags:', ttError);
      throw new Error(`Failed to fetch tags: ${ttError.message}`);
    }

    const tagCountMap = new Map(); // tag_id -> { id, name, count }
    for (const row of ttRows ?? []) {
      const tagId = row.tag_id;
      const tagName = row.tags_tasks?.name ?? null;
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

    // 2) Находим задачи пользователя старше cutoff, у которых есть любой из topTagIds
    const { data: taskIdsRows, error: taskIdsError } = await supabase
      .from('task_tags')
      .select(`
        task_id,
        tasks!inner ( id, user_id, created_at )
      `)
      .in('tag_id', topTagIds)
      .eq('tasks.user_id', user.id)
      .lte('tasks.created_at', cutoffISO);

    if (taskIdsError) {
      console.error('Error fetching task ids:', taskIdsError);
      throw new Error(`Failed to fetch tasks: ${taskIdsError.message}`);
    }

    const taskIdSet = new Set();
    for (const row of taskIdsRows ?? []) {
      if (row.task_id) taskIdSet.add(row.task_id);
    }

    let taskIds = Array.from(taskIdSet);
    if (taskIds.length === 0) {
      return new Response(JSON.stringify({ success: true, data: [], message: 'No tasks matched top tags' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3) Получаем полные данные по задачам, как в get-task-by-id.js, пачкой
    // Сначала получим заголовки и сортировку, чтобы ограничить limit по дате
    const { data: baseTasks, error: baseErr } = await supabase
      .from('tasks')
      .select('id, user_id, title, description, select_date, select_time, repeat, reminder, is_completed, created_at')
      .in('id', taskIds)
      .eq('user_id', user.id)
      .lte('created_at', cutoffISO)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (baseErr) {
      console.error('Error fetching tasks base:', baseErr);
      throw new Error(`Failed to fetch tasks: ${baseErr.message}`);
    }

    taskIds = (baseTasks ?? []).map(t => t.id);
    if (taskIds.length === 0) {
      return new Response(JSON.stringify({ success: true, data: [], message: 'No tasks within limit' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Параллельно подтянем связанные сущности
    const [imagesRes, audioRes, tagsRes, subtasksRes, goalsRes] = await Promise.all([
      supabase.from('task_image').select('id, url, created_at, task_id').in('task_id', taskIds).order('created_at', { ascending: true }),
      supabase.from('task_audio').select('id, url, created_at, task_id').in('task_id', taskIds).order('created_at', { ascending: true }),
      supabase.from('task_tags').select('task_id, tags_tasks(id, name)').in('task_id', taskIds),
      supabase.from('subtasks').select('id, title, is_completed, created_at, task_id').in('task_id', taskIds).order('created_at', { ascending: true }),
      supabase.from('task_goals').select('task_id, goal_id, goals(id, title, deadline, created_at)').in('task_id', taskIds),
    ]);

    if (imagesRes.error) console.error('Error fetching images:', imagesRes.error);
    if (audioRes.error) console.error('Error fetching audio:', audioRes.error);
    if (tagsRes.error) console.error('Error fetching tags:', tagsRes.error);
    if (subtasksRes.error) console.error('Error fetching subtasks:', subtasksRes.error);
    if (goalsRes.error) console.error('Error fetching goals:', goalsRes.error);

    const imagesByTask = new Map();
    for (const img of imagesRes.data ?? []) {
      const arr = imagesByTask.get(img.task_id) || [];
      arr.push({ id: img.id, url: img.url, createdAt: img.created_at });
      imagesByTask.set(img.task_id, arr);
    }

    const audioByTask = new Map();
    for (const aud of audioRes.data ?? []) {
      const arr = audioByTask.get(aud.task_id) || [];
      arr.push({ id: aud.id, url: aud.url, createdAt: aud.created_at });
      audioByTask.set(aud.task_id, arr);
    }

    const tagsByTask = new Map();
    for (const row of tagsRes.data ?? []) {
      const arr = tagsByTask.get(row.task_id) || [];
      if (row.tags_tasks) arr.push({ id: row.tags_tasks.id, name: row.tags_tasks.name });
      tagsByTask.set(row.task_id, arr);
    }

    const subtasksByTask = new Map();
    for (const sub of subtasksRes.data ?? []) {
      const arr = subtasksByTask.get(sub.task_id) || [];
      arr.push({ id: sub.id, title: sub.title, isCompleted: sub.is_completed, createdAt: sub.created_at });
      subtasksByTask.set(sub.task_id, arr);
    }

    const goalsByTask = new Map();
    for (const row of goalsRes.data ?? []) {
      const arr = goalsByTask.get(row.task_id) || [];
      if (row.goals) {
        arr.push({
          id: row.goals.id,
          title: row.goals.title,
          deadline: row.goals.deadline,
          createdAt: row.goals.created_at,
        });
      }
      goalsByTask.set(row.task_id, arr);
    }

    const result = (baseTasks ?? []).map(t => {
      const images = imagesByTask.get(t.id) || [];
      const audio = audioByTask.get(t.id) || [];
      const tags = tagsByTask.get(t.id) || [];
      const subtasks = subtasksByTask.get(t.id) || [];
      const goals = goalsByTask.get(t.id) || [];
      return {
        id: t.id,
        title: t.title,
        description: t.description,
        selectDate: t.select_date,
        selectTime: t.select_time,
        repeat: t.repeat,
        reminder: t.reminder,
        isCompleted: t.is_completed,
        createdAt: t.created_at,
        tags,
        subtasks,
        images,
        audio,
        goals,
        countMedia: images.length + audio.length,
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
        message: 'Tasks by frequent older tags retrieved successfully',
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    console.error('❌ Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message || 'An unknown error occurred', message: 'Failed to retrieve tasks' }),
      { status: error.message?.includes('not authenticated') ? 401 : 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});


