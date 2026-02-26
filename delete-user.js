import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * Supabase Edge Function: delete-user
 *
 * Полное удаление пользователя и ВСЕХ связанных данных:
 * - задачи (tasks, subtasks, task_goals, task_tags, task_image, task_audio)
 * - цели (goals)
 * - журнал (journal, journal_image, journal_audio, journal_tag, journal_location)
 * - теги и локации (tags, tags_tasks, locations)
 * - награды (rewards_users, rewards_users_tasks)
 * - файлы из Supabase Storage, связанные с задачами и журналом
 * - запись пользователя в auth (auth.admin.deleteUser)
 *
 * 🔐 Авторизация
 * - Метод: POST
 * - URL: /functions/v1/delete-user
 * - Заголовки:
 *   - Authorization: Bearer <user_access_token> (ОБЯЗАТЕЛЬНО)
 *   - apikey: <SUPABASE_ANON_KEY> (как обычно для Edge Functions)
 *
 * 📥 Тело запроса
 * - JSON тело не обязательно, функция берет пользователя из токена.
 * - Можно отправлять пустое тело `{}`.
 *
 * 📤 Успешный ответ (HTTP 200)
 * {
 *   "success": true,
 *   "message": "User and related data deleted",
 *   "results": {
 *     "deleted": {
 *       "tasks": number,
 *       "subtasks": number,
 *       "task_goals": number,
 *       "task_tags": number,
 *       "task_images": number,
 *       "task_audio": number,
 *       "goals": number,
 *       "journals": number,
 *       "journal_images": number,
 *       "journal_audio": number,
 *       "journal_tags": number,
 *       "journal_locations": number,
 *       "tags_tasks": number,
 *       "tags": number,
 *       "locations": number,
 *       "rewards_users": number,
 *       "rewards_users_tasks": number,
 *       "storage_files": number
 *     },
 *     "warnings": [ "строки с описанием проблем при удалении файлов/строк" ]
 *   }
 * }
 *
 * ❌ Ошибки
 * - 401: нет/невалидный Authorization токен
 *   { "success": false, "error": "User not authenticated" }
 * - 500: внутренняя ошибка / проблемы с конфигурацией Supabase / удалением данных
 *   { "success": false, "error": "<описание ошибки>" }
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
      ...(init.headers ?? {}),
    },
  });

const MAX_CONCURRENT_OPERATIONS = 5;

const processInBatches = async (items, handler, batchSize = MAX_CONCURRENT_OPERATIONS) => {
  const settledResults = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(handler));
    settledResults.push(...results);
  }
  return settledResults;
};

const parsePublicStorageUrl = (url) => {
  const urlObj = new URL(url);
  const marker = '/storage/v1/object/public/';
  const markerIndex = urlObj.pathname.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error('Invalid public URL: marker not found');
  }

  const afterMarker = urlObj.pathname.slice(markerIndex + marker.length);
  const parts = afterMarker.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (parts.length < 2) {
    throw new Error('Invalid public URL: path too short');
  }

  const bucket = parts.shift();
  const sourcePath = parts.join('/');
  const fileName = parts[parts.length - 1] || 'file';

  return { bucket, sourcePath, fileName };
};

const chunkArray = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json(
      {
        success: false,
        error: 'Method not allowed',
        message: 'Only POST requests are supported',
      },
      { status: 405 },
    );
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json(
        {
          success: false,
          error: 'Missing authorization token',
        },
        { status: 401 },
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return json(
        {
          success: false,
          error: 'Missing Supabase configuration',
        },
        { status: 500 },
      );
    }

    const userClient = createClient(
      supabaseUrl,
      supabaseAnonKey,
      {
        global: {
          headers: { Authorization: authHeader },
        },
        auth: {
          persistSession: false,
          detectSessionInUrl: false,
        },
      },
    );

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return json(
        {
          success: false,
          error: 'User not authenticated',
        },
        { status: 401 },
      );
    }

    const supabaseAdmin = createClient(
      supabaseUrl,
      supabaseServiceRoleKey,
      {
        auth: {
          persistSession: false,
          detectSessionInUrl: false,
        },
      },
    );

    const results = {
      deleted: {
        tasks: 0,
        subtasks: 0,
        task_goals: 0,
        task_tags: 0,
        task_images: 0,
        task_audio: 0,
        goals: 0,
        journals: 0,
        journal_images: 0,
        journal_audio: 0,
        journal_tags: 0,
        journal_locations: 0,
        tags_tasks: 0,
        tags: 0,
        locations: 0,
        rewards_users: 0,
        rewards_users_tasks: 0,
        storage_files: 0,
      },
      warnings: [],
    };

    // Fetch user-owned entities for cleanup
    const { data: tasks, error: tasksError } = await supabaseAdmin
      .from('tasks')
      .select('id')
      .eq('user_id', user.id);
    if (tasksError) throw new Error(`Failed to fetch tasks: ${tasksError.message}`);
    const taskIds = (tasks ?? []).map((t) => t.id);

    const { data: goals, error: goalsError } = await supabaseAdmin
      .from('goals')
      .select('id')
      .eq('user_id', user.id);
    if (goalsError) throw new Error(`Failed to fetch goals: ${goalsError.message}`);
    const goalIds = (goals ?? []).map((g) => g.id);

    const { data: journals, error: journalsError } = await supabaseAdmin
      .from('journal')
      .select('id, title_image')
      .eq('user_id', user.id);
    if (journalsError) throw new Error(`Failed to fetch journals: ${journalsError.message}`);
    const journalIds = (journals ?? []).map((j) => j.id);

    // Collect storage URLs
    const urlsToRemove = new Set();

    if (journals?.length) {
      journals
        .map((j) => j.title_image)
        .filter((url) => typeof url === 'string' && url.trim().length > 0)
        .forEach((url) => urlsToRemove.add(url.trim()));
    }

    let taskImages = [];
    if (taskIds.length > 0) {
      const { data, error } = await supabaseAdmin
        .from('task_image')
        .select('id, url, task_id')
        .in('task_id', taskIds);
      if (error) throw new Error(`Failed to fetch task images: ${error.message}`);
      taskImages = data ?? [];
      taskImages
        .map((row) => row.url)
        .filter((url) => typeof url === 'string' && url.trim().length > 0)
        .forEach((url) => urlsToRemove.add(url.trim()));
    }

    let taskAudio = [];
    if (taskIds.length > 0) {
      const { data, error } = await supabaseAdmin
        .from('task_audio')
        .select('id, url, task_id')
        .in('task_id', taskIds);
      if (error) throw new Error(`Failed to fetch task audio: ${error.message}`);
      taskAudio = data ?? [];
      taskAudio
        .map((row) => row.url)
        .filter((url) => typeof url === 'string' && url.trim().length > 0)
        .forEach((url) => urlsToRemove.add(url.trim()));
    }

    let journalImages = [];
    if (journalIds.length > 0) {
      const { data, error } = await supabaseAdmin
        .from('journal_image')
        .select('id, url, journal_id')
        .in('journal_id', journalIds);
      if (error) throw new Error(`Failed to fetch journal images: ${error.message}`);
      journalImages = data ?? [];
      journalImages
        .map((row) => row.url)
        .filter((url) => typeof url === 'string' && url.trim().length > 0)
        .forEach((url) => urlsToRemove.add(url.trim()));
    }

    let journalAudio = [];
    if (journalIds.length > 0) {
      const { data, error } = await supabaseAdmin
        .from('journal_audio')
        .select('id, url, journal_id')
        .in('journal_id', journalIds);
      if (error) throw new Error(`Failed to fetch journal audio: ${error.message}`);
      journalAudio = data ?? [];
      journalAudio
        .map((row) => row.url)
        .filter((url) => typeof url === 'string' && url.trim().length > 0)
        .forEach((url) => urlsToRemove.add(url.trim()));
    }

    // Remove storage objects
    if (urlsToRemove.size > 0) {
      const bucketsMap = new Map();

      for (const url of urlsToRemove) {
        try {
          const { bucket, sourcePath } = parsePublicStorageUrl(url);
          if (!bucketsMap.has(bucket)) bucketsMap.set(bucket, new Set());
          bucketsMap.get(bucket).add(sourcePath);
        } catch (err) {
          results.warnings.push(`Skipping invalid storage URL: ${url}`);
        }
      }

      for (const [bucket, pathsSet] of bucketsMap.entries()) {
        const paths = Array.from(pathsSet).filter(Boolean);
        const chunks = chunkArray(paths, 100);
        for (const chunk of chunks) {
          const { error: removeError } = await supabaseAdmin.storage
            .from(bucket)
            .remove(chunk);
          if (removeError) {
            results.warnings.push(`Failed to remove files from ${bucket}: ${removeError.message}`);
          } else {
            results.deleted.storage_files += chunk.length;
          }
        }
      }
    }

    // Delete related rows in correct order
    if (taskIds.length > 0) {
      const { error: taskTagsError, count: taskTagsCount } = await supabaseAdmin
        .from('task_tags')
        .delete({ count: 'exact' })
        .in('task_id', taskIds);
      if (taskTagsError) throw new Error(`Failed to delete task_tags: ${taskTagsError.message}`);
      results.deleted.task_tags += taskTagsCount ?? 0;

      const { error: taskGoalsError, count: taskGoalsCount } = await supabaseAdmin
        .from('task_goals')
        .delete({ count: 'exact' })
        .in('task_id', taskIds);
      if (taskGoalsError) throw new Error(`Failed to delete task_goals: ${taskGoalsError.message}`);
      results.deleted.task_goals += taskGoalsCount ?? 0;

      const { error: subtasksError, count: subtasksCount } = await supabaseAdmin
        .from('subtasks')
        .delete({ count: 'exact' })
        .in('task_id', taskIds);
      if (subtasksError) throw new Error(`Failed to delete subtasks: ${subtasksError.message}`);
      results.deleted.subtasks += subtasksCount ?? 0;

      const { error: taskImageError, count: taskImageCount } = await supabaseAdmin
        .from('task_image')
        .delete({ count: 'exact' })
        .in('task_id', taskIds);
      if (taskImageError) throw new Error(`Failed to delete task_image: ${taskImageError.message}`);
      results.deleted.task_images += taskImageCount ?? 0;

      const { error: taskAudioError, count: taskAudioCount } = await supabaseAdmin
        .from('task_audio')
        .delete({ count: 'exact' })
        .in('task_id', taskIds);
      if (taskAudioError) throw new Error(`Failed to delete task_audio: ${taskAudioError.message}`);
      results.deleted.task_audio += taskAudioCount ?? 0;
    }

    if (journalIds.length > 0) {
      const { error: journalTagsError, count: journalTagsCount } = await supabaseAdmin
        .from('journal_tag')
        .delete({ count: 'exact' })
        .in('journal_id', journalIds);
      if (journalTagsError) throw new Error(`Failed to delete journal_tag: ${journalTagsError.message}`);
      results.deleted.journal_tags += journalTagsCount ?? 0;

      const { error: journalLocationError, count: journalLocationCount } = await supabaseAdmin
        .from('journal_location')
        .delete({ count: 'exact' })
        .in('journal_id', journalIds);
      if (journalLocationError) throw new Error(`Failed to delete journal_location: ${journalLocationError.message}`);
      results.deleted.journal_locations += journalLocationCount ?? 0;

      const { error: journalImageError, count: journalImageCount } = await supabaseAdmin
        .from('journal_image')
        .delete({ count: 'exact' })
        .in('journal_id', journalIds);
      if (journalImageError) throw new Error(`Failed to delete journal_image: ${journalImageError.message}`);
      results.deleted.journal_images += journalImageCount ?? 0;

      const { error: journalAudioError, count: journalAudioCount } = await supabaseAdmin
        .from('journal_audio')
        .delete({ count: 'exact' })
        .in('journal_id', journalIds);
      if (journalAudioError) throw new Error(`Failed to delete journal_audio: ${journalAudioError.message}`);
      results.deleted.journal_audio += journalAudioCount ?? 0;
    }

    if (goalIds.length > 0) {
      const { error: taskGoalsByGoalError, count: taskGoalsByGoalCount } = await supabaseAdmin
        .from('task_goals')
        .delete({ count: 'exact' })
        .in('goal_id', goalIds);
      if (taskGoalsByGoalError) throw new Error(`Failed to delete task_goals by goal: ${taskGoalsByGoalError.message}`);
      results.deleted.task_goals += taskGoalsByGoalCount ?? 0;
    }

    const { error: rewardsUsersTasksError, count: rewardsUsersTasksCount } = await supabaseAdmin
      .from('rewards_users_tasks')
      .delete({ count: 'exact' })
      .eq('user_id', user.id);
    if (rewardsUsersTasksError) throw new Error(`Failed to delete rewards_users_tasks: ${rewardsUsersTasksError.message}`);
    results.deleted.rewards_users_tasks += rewardsUsersTasksCount ?? 0;

    const { error: rewardsUsersError, count: rewardsUsersCount } = await supabaseAdmin
      .from('rewards_users')
      .delete({ count: 'exact' })
      .eq('user_id', user.id);
    if (rewardsUsersError) throw new Error(`Failed to delete rewards_users: ${rewardsUsersError.message}`);
    results.deleted.rewards_users += rewardsUsersCount ?? 0;

    if (taskIds.length > 0) {
      const { error: tasksDeleteError, count: tasksCount } = await supabaseAdmin
        .from('tasks')
        .delete({ count: 'exact' })
        .in('id', taskIds);
      if (tasksDeleteError) throw new Error(`Failed to delete tasks: ${tasksDeleteError.message}`);
      results.deleted.tasks += tasksCount ?? 0;
    }

    if (journalIds.length > 0) {
      const { error: journalsDeleteError, count: journalsCount } = await supabaseAdmin
        .from('journal')
        .delete({ count: 'exact' })
        .in('id', journalIds);
      if (journalsDeleteError) throw new Error(`Failed to delete journals: ${journalsDeleteError.message}`);
      results.deleted.journals += journalsCount ?? 0;
    }

    if (goalIds.length > 0) {
      const { error: goalsDeleteError, count: goalsCount } = await supabaseAdmin
        .from('goals')
        .delete({ count: 'exact' })
        .in('id', goalIds);
      if (goalsDeleteError) throw new Error(`Failed to delete goals: ${goalsDeleteError.message}`);
      results.deleted.goals += goalsCount ?? 0;
    }

    const { error: tagsTasksDeleteError, count: tagsTasksCount } = await supabaseAdmin
      .from('tags_tasks')
      .delete({ count: 'exact' })
      .eq('user_id', user.id);
    if (tagsTasksDeleteError) throw new Error(`Failed to delete tags_tasks: ${tagsTasksDeleteError.message}`);
    results.deleted.tags_tasks += tagsTasksCount ?? 0;

    const { error: tagsDeleteError, count: tagsCount } = await supabaseAdmin
      .from('tags')
      .delete({ count: 'exact' })
      .eq('user_id', user.id);
    if (tagsDeleteError) throw new Error(`Failed to delete tags: ${tagsDeleteError.message}`);
    results.deleted.tags += tagsCount ?? 0;

    const { error: locationsDeleteError, count: locationsCount } = await supabaseAdmin
      .from('locations')
      .delete({ count: 'exact' })
      .eq('user_id', user.id);
    if (locationsDeleteError) throw new Error(`Failed to delete locations: ${locationsDeleteError.message}`);
    results.deleted.locations += locationsCount ?? 0;

    const { error: deleteUserError } = await supabaseAdmin.auth.admin.deleteUser(user.id);
    if (deleteUserError) {
      throw new Error(`Failed to delete auth user: ${deleteUserError.message}`);
    }

    return json(
      {
        success: true,
        message: 'User and related data deleted',
        results,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('❌ Error deleting user:', error);
    return json(
      {
        success: false,
        error: error.message || 'Unknown error',
      },
      { status: 500 },
    );
  }
});
