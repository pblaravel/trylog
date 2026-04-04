import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
    createClient
} from 'jsr:@supabase/supabase-js@2';

/**
 * Supabase Edge Function: save-task
 *
 * Создание или редактирование задачи. При передаче "id" (или "taskId") — обновление существующей задачи.
 *
 * Повторяемость (repeat): при создании задачи с repeat !== "No Repeats" и заданным end_date
 * создаются дочерние задачи в интервале [selectDate, end_date] с parent_id = id родителя.
 * Подзадачи дублируются для каждого дочернего экземпляра (как у родителя на дату selectDate).
 * Поддерживаются: Daily, Weekly, Bi-weekly, Monthly, Annually; для Custom — опционально repeatIntervalDays (число дней).
 *
 * При редактировании: если repeat меняется на "No Repeats" — удаляются все будущие дочерние по parent_id;
 * если меняется тип repeat — у всех дочерних обновляются repeat и end_date.
 *
 * Пример запроса:
 *
 * POST /functions/v1/save-task
 * Authorization: Bearer <user access token>
 * Content-Type: application/json
 *
 * {
 *   "id": "uuid",                            // опционально, UUID задачи для редактирования (или "taskId")
 *   "title": "Morning workout",              // обязательно, строка
 *   "description": "Leg day routine",         // опционально, строка
 *   "selectDate": "2025-04-01",              // опционально, формат YYYY-MM-DD
 *   "selectTime": "07:30",                   // опционально, формат HH:MM или HH:MM:SS (24h)
 *   "end_date": "2025-12-31",                // опционально, формат YYYY-MM-DD (для repeat)
 *   "repeat": "Weekly",                      // опционально: No Repeats, Daily, Weekly, Bi-weekly, Monthly, Annually, Custom
 *   "repeatIntervalDays": 7,                 // опционально, для Custom — интервал в днях
 *   "reminder": "noReminders",               // опционально, одно из: noReminders, fiveMinutes, ...
 *   "isCompleted": false,                     // опционально, boolean
 *   "tags": ["Health", "Workout"],            // опционально, массив строк (при создании)
 *   "imageUrls": ["https://..."],             // опционально (при создании)
 *   "audioUrls": ["https://..."],             // опционально (при создании)
 *   "subtasks": [{"title": "Warm up", "isCompleted": false}],  // опционально (при создании)
 *   "goalIds": ["8a6f1b6c-..."]              // опционально, массив UUID целей (при создании)
 * }
 */

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const allowedRepeats = new Set([
    'No Repeats',
    'Daily',
    'Weekly',
    'Bi-weekly',
    'Monthly',
    'Annually',
    'Custom',
]);

const allowedReminders = new Set([
    'noReminders',
    'fiveMinutes',
    'tenMinutes',
    'fifteenMinutes',
    'thirtyMinutes',
    'oneHour',
    'oneDay',
]);

const normalizeDate = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
    return trimmed;
};

const normalizeTime = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
    if (!match) return null;
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const seconds = match[3] ? parseInt(match[3], 10) : 0;
    if (
        Number.isNaN(hours) ||
        Number.isNaN(minutes) ||
        Number.isNaN(seconds) ||
        hours < 0 ||
        hours > 23 ||
        minutes < 0 ||
        minutes > 59 ||
        seconds < 0 ||
        seconds > 59
    ) {
        return null;
    }
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const normalizeRepeat = (value) => {
    if (typeof value !== 'string') return 'No Repeats';
    const trimmed = value.trim();
    return allowedRepeats.has(trimmed) ? trimmed : 'No Repeats';
};

const normalizeReminder = (value) => {
    if (typeof value !== 'string') return 'noReminders';
    const trimmed = value.trim();
    return allowedReminders.has(trimmed) ? trimmed : 'noReminders';
};

const UUID_REGEX = /^[0-9a-fA-F-]{36}$/;

const validateUuid = (value) => {
    if (value == null) return null;
    const s = typeof value === 'string' ? value.trim() : String(value);
    return UUID_REGEX.test(s) ? s : null;
};

/** YYYY-MM-DD → { y, m, d } (m 1-based) */
const parseDateParts = (dateStr) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!match) return null;
    const y = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const d = parseInt(match[3], 10);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return {
        y,
        m,
        d
    };
};

const formatDate = (y, m, d) =>
    `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

const daysInMonth = (y, m) => {
    if (m === 2) return isLeapYear(y) ? 29 : 28;
    if ([4, 6, 9, 11].includes(m)) return 30;
    return 31;
};

/** Сравнение дат YYYY-MM-DD: -1 if a < b, 0 if a === b, 1 if a > b */
const compareDate = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Генерирует даты повторений от startDate (не включая) до endDate включительно.
 * repeat: Daily | Weekly | Bi-weekly | Monthly | Annually | Custom (при Custom передать intervalDays).
 * Возвращает массив строк YYYY-MM-DD.
 */
const getRepeatDates = (repeat, startDate, endDate, intervalDays = 0) => {
    const start = parseDateParts(startDate);
    const end = parseDateParts(endDate);
    if (!start || !end || compareDate(startDate, endDate) > 0) return [];

    const out = [];
    const addDay = (y, m, d, deltaDays) => {
        const t = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
        const dt = new Date(t);
        return formatDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    };

    if (repeat === 'Daily') {
        for (let d = 1;; d++) {
            const next = addDay(start.y, start.m, start.d, d);
            if (compareDate(next, endDate) > 0) break;
            out.push(next);
        }
        return out;
    }

    if (repeat === 'Weekly') {
        for (let w = 1;; w++) {
            const next = addDay(start.y, start.m, start.d, w * 7);
            if (compareDate(next, endDate) > 0) break;
            out.push(next);
        }
        return out;
    }

    if (repeat === 'Bi-weekly') {
        for (let w = 1;; w++) {
            const next = addDay(start.y, start.m, start.d, w * 14);
            if (compareDate(next, endDate) > 0) break;
            out.push(next);
        }
        return out;
    }

    if (repeat === 'Monthly') {
        let y = start.y;
        let m = start.m;
        let d = Math.min(start.d, daysInMonth(y, m));
        for (;;) {
            m += 1;
            if (m > 12) {
                m = 1;
                y += 1;
            }
            const lastDay = daysInMonth(y, m);
            const day = Math.min(d, lastDay);
            const next = formatDate(y, m, day);
            if (compareDate(next, endDate) > 0) break;
            out.push(next);
        }
        return out;
    }

    if (repeat === 'Annually') {
        let d = start.d;
        let m = start.m;
        if (m === 2 && d === 29 && !isLeapYear(start.y)) d = 28;
        for (let y = start.y + 1; y <= end.y; y++) {
            const lastDay = daysInMonth(y, m);
            const day = Math.min(d, lastDay);
            const next = formatDate(y, m, day);
            if (compareDate(next, endDate) > 0) break;
            out.push(next);
        }
        return out;
    }

    if (repeat === 'Custom' && intervalDays > 0) {
        for (let n = 1;; n++) {
            const next = addDay(start.y, start.m, start.d, n * intervalDays);
            if (compareDate(next, endDate) > 0) break;
            out.push(next);
        }
        return out;
    }

    return [];
};

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

    return {
        bucket,
        sourcePath,
        fileName
    };
};

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: corsHeaders,
        });
    }

    if (req.method !== 'POST') {
        return new Response(
            JSON.stringify({
                success: false,
                error: 'Method not allowed',
                message: 'Only POST requests are supported',
            }), {
                status: 405,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json',
                },
            },
        );
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
        }
        );

        // Verify user authentication
        const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
        if (userError || !user) {
        throw new Error('User not authenticated');
        }

        let payload;
        try {
            payload = await req.json();
        } catch {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: 'Invalid JSON payload',
                }), {
                    status: 400,
                    headers: {
                        ...corsHeaders,
                        'Content-Type': 'application/json'
                    },
                },
            );
        }

        const {
            id: payloadId,
            taskId: payloadTaskId,
            title,
            description = null,
            selectDate = null,
            selectTime = null,
            end_date: payloadEndDate = null,
            repeat = 'No Repeats',
            repeatIntervalDays,
            reminder = 'noReminders',
            isCompleted = false,
            tags = [],
            imageUrls = [],
            audioUrls = [],
            subtasks = [],
            goalIds = [],
        } = payload ?? {};

        if (!title || typeof title !== 'string' || title.trim() === '') {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: 'Task title is required',
                }), {
                    status: 400,
                    headers: {
                        ...corsHeaders,
                        'Content-Type': 'application/json'
                    },
                },
            );
        }

        const normalizedDate = normalizeDate(selectDate);
        if (selectDate && normalizedDate === null) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: 'Invalid selectDate format. Expected YYYY-MM-DD',
                }), {
                    status: 400,
                    headers: {
                        ...corsHeaders,
                        'Content-Type': 'application/json'
                    },
                },
            );
        }

        const normalizedTime = normalizeTime(selectTime);
        if (selectTime && normalizedTime === null) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: 'Invalid selectTime format. Expected HH:MM or HH:MM:SS (24h)',
                }), {
                    status: 400,
                    headers: {
                        ...corsHeaders,
                        'Content-Type': 'application/json'
                    },
                },
            );
        }
        const normalizedRepeat = normalizeRepeat(repeat);
        const normalizedReminder = normalizeReminder(reminder);
        const normalizedIsCompleted = Boolean(isCompleted);
        const normalizedEndDate = normalizeDate(payloadEndDate);
        if (payloadEndDate && normalizedEndDate === null) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: 'Invalid end_date format. Expected YYYY-MM-DD',
                }), {
                    status: 400,
                    headers: {
                        ...corsHeaders,
                        'Content-Type': 'application/json'
                    },
                },
            );
        }
        const taskIdForUpdate = validateUuid(payloadId ?? payloadTaskId);
        const isUpdate = taskIdForUpdate !== null;

        let normalizedSubtasks = [];
        if (!isUpdate && Array.isArray(subtasks)) {
            normalizedSubtasks = subtasks
                .map((raw) => {
                    if (typeof raw === 'string') {
                        const trimmed = raw.trim();
                        return trimmed.length > 0 ? {
                            title: trimmed,
                            isCompleted: false
                        } : null;
                    }
                    if (raw && typeof raw === 'object' && typeof raw.title === 'string') {
                        const trimmed = raw.title.trim();
                        if (trimmed.length === 0) return null;
                        return {
                            title: trimmed,
                            isCompleted: Boolean(raw.isCompleted),
                        };
                    }
                    return null;
                })
                .filter(Boolean);
        }

        const taskPayload = {
            title: title.trim(),
            description: typeof description === 'string' ? description.trim() || null : null,
            select_date: normalizedDate,
            select_time: normalizedTime,
            repeat: normalizedRepeat,
            reminder: normalizedReminder,
            is_completed: normalizedIsCompleted,
            user_id: user.id,
            end_date: normalizedEndDate,
        };

        let task;
        let previousRepeat;
        let previousSelectDate;
        const selectColumns = 'id, user_id, title, description, select_date, select_time, repeat, reminder, is_completed, created_at, end_date';

        if (isUpdate) {
            const {
                data: existingTask,
                error: fetchError
            } = await supabaseClient
                .from('tasks')
                .select('id, user_id, repeat, select_date')
                .eq('id', taskIdForUpdate)
                .single();

            if (fetchError || !existingTask) {
                return new Response(
                    JSON.stringify({
                        success: false,
                        error: 'Task not found or access denied',
                    }), {
                        status: 404,
                        headers: {
                            ...corsHeaders,
                            'Content-Type': 'application/json'
                        },
                    },
                );
            }
            if (existingTask.user_id !== user.id) {
                return new Response(
                    JSON.stringify({
                        success: false,
                        error: 'Task not found or access denied',
                    }), {
                        status: 404,
                        headers: {
                            ...corsHeaders,
                            'Content-Type': 'application/json'
                        },
                    },
                );
            }

            previousRepeat = existingTask.repeat;
            previousSelectDate = existingTask.select_date;

            const updateClient = supabaseClient;
            const {
                data: updatedTask,
                error: updateError
            } = await updateClient
                .from('tasks')
                .update(taskPayload)
                .eq('id', taskIdForUpdate)
                .eq('user_id', user.id)
                .select(selectColumns)
                .single();

            if (updateError) {
                console.error('❌ Error updating task:', updateError);
                throw new Error(`Failed to update task: ${updateError.message}`);
            }
            if (!updatedTask?.id) {
                throw new Error('Task update failed: no task data returned. Check RLS or triggers.');
            }
            task = updatedTask;
        } else {
            const insertClient = supabaseClient;
            const {
                data: insertedTask,
                error: taskError
            } = await insertClient
                .from('tasks')
                .insert(taskPayload)
                .select(selectColumns)
                .single();

            if (taskError) {
                console.error('❌ Error creating task:', taskError);
                throw new Error(`Failed to create task: ${taskError.message}`);
            }
            if (!insertedTask?.id) {
                throw new Error('Task create failed: no task data returned. Check RLS or triggers.');
            }
            task = insertedTask;
        }

        // Создание дочерних задач при insert с repeat и end_date
        if (!isUpdate && normalizedRepeat !== 'No Repeats' && normalizedDate && normalizedEndDate && compareDate(normalizedDate, normalizedEndDate) <= 0) {
            const useCustomInterval = normalizedRepeat === 'Custom' && typeof repeatIntervalDays === 'number' && repeatIntervalDays > 0;
            const dates = getRepeatDates(
                normalizedRepeat,
                normalizedDate,
                normalizedEndDate,
                useCustomInterval ? repeatIntervalDays : 0,
            );
            if (dates.length > 0) {
                const childPayload = {
                    title: taskPayload.title,
                    description: taskPayload.description,
                    select_time: taskPayload.select_time,
                    repeat: taskPayload.repeat,
                    reminder: taskPayload.reminder,
                    is_completed: false,
                    user_id: user.id,
                    parent_id: task.id,
                    end_date: taskPayload.end_date,
                };
                const childInserts = dates.map((date) => ({
                    ...childPayload,
                    select_date: date
                }));
                const {
                    data: insertedChildren,
                    error: childrenError
                } = await supabaseClient.from('tasks').insert(childInserts).select('id');
                if (childrenError) {
                    console.warn('⚠️ Error creating repeat child tasks:', childrenError.message);
                } else if (normalizedSubtasks.length > 0 && insertedChildren?.length) {
                    const subtasksForChildren = insertedChildren.flatMap((child) =>
                        normalizedSubtasks.map((item) => ({
                            task_id: child.id,
                            user_id: user.id,
                            title: item.title,
                            is_completed: item.isCompleted,
                        }))
                    );
                    const {
                        error: childSubtasksError
                    } = await supabaseClient.from('subtasks').insert(subtasksForChildren);
                    if (childSubtasksError) {
                        console.warn('⚠️ Error copying subtasks to repeat tasks:', childSubtasksError.message);
                    }
                }
            }
        }

        // При редактировании: repeat → No Repeats — удалить будущие дочерние
        if (isUpdate && normalizedRepeat === 'No Repeats' && task.select_date) {
            const {
                error: deleteError
            } = await supabaseClient
                .from('tasks')
                .delete()
                .eq('parent_id', task.id)
                .gt('select_date', task.select_date);
            if (deleteError) {
                console.warn('⚠️ Error deleting future repeat tasks:', deleteError.message);
            }
        }

        // При редактировании: смена типа repeat — обновить дочерние
        if (isUpdate && normalizedRepeat !== 'No Repeats' && normalizedRepeat !== previousRepeat) {
            const {
                error: updateChildrenError
            } = await supabaseClient
                .from('tasks')
                .update({
                    repeat: normalizedRepeat,
                    end_date: normalizedEndDate
                })
                .eq('parent_id', task.id);
            if (updateChildrenError) {
                console.warn('⚠️ Error updating repeat child tasks:', updateChildrenError.message);
            }
        }

        const results = {
            task,
            endDate: task?.end_date ?? taskPayload?.end_date ?? null,
            subtasks: [],
            tags: [],
            goals: [],
            images: [],
            audio: [],
            errors: [],
        };

        // Инициализируем массив операций для параллельного выполнения (только при создании)
        const operations = [];

        if (!isUpdate) {
            // Handle tags - оптимизировано: батчинг вместо последовательных запросов
            const normalizedTags = Array.isArray(tags) ?
                tags
                .map((raw) => {
                    if (typeof raw === 'string') {
                        const trimmed = raw.trim();
                        return trimmed.length > 0 ? trimmed : null;
                    }
                    return null;
                })
                .filter(Boolean) : [];

            // Уникализация тегов (case-insensitive)
            const uniqueTagMap = new Map();
            for (const tagName of normalizedTags) {
                const key = tagName.toLowerCase();
                if (!uniqueTagMap.has(key)) {
                    uniqueTagMap.set(key, tagName);
                }
            }
            const uniqueTagNames = Array.from(uniqueTagMap.values());

            if (uniqueTagNames.length > 0) {
                try {
                    const {
                        data: existingTags,
                        error: findTagsError
                    } = await supabaseClient
                        .from('tags_tasks')
                        .select('id, name')
                        .eq('user_id', user.id)
                        .in('name', uniqueTagNames);

                    if (findTagsError) {
                        console.error('⚠️ Error fetching tags:', findTagsError);
                        results.errors.push({
                            type: 'tags',
                            message: findTagsError.message,
                        });
                    } else {
                        const existingNames = new Map(
                            (existingTags ?? []).map((tag) => [tag.name.toLowerCase(), tag]),
                        );

                        const missingNames = uniqueTagNames.filter(
                            (name) => !existingNames.has(name.toLowerCase()),
                        );

                        const tagIdsToLink = [];
                        existingNames.forEach((tag) => tagIdsToLink.push(tag.id));

                        if (missingNames.length > 0) {
                            const inserts = missingNames.map((name) => ({
                                name,
                                user_id: user.id,
                            }));

                            const {
                                data: createdTags,
                                error: createTagsError
                            } = await supabaseClient
                                .from('tags_tasks')
                                .insert(inserts)
                                .select('id, name');

                            if (createTagsError) {
                                console.error('⚠️ Error creating tags:', createTagsError);
                                results.errors.push({
                                    type: 'tags',
                                    message: createTagsError.message,
                                });
                            } else if (createdTags) {
                                createdTags.forEach((tag) => tagIdsToLink.push(tag.id));
                            }
                        }

                        if (tagIdsToLink.length > 0) {
                            const tagsToInsert = Array.from(new Set(tagIdsToLink)).map((tagId) => ({
                                task_id: task.id,
                                tag_id: tagId,
                            }));

                            const {
                                data: linkedTags,
                                error: linkError
                            } = await supabaseClient
                                .from('task_tags')
                                .insert(tagsToInsert)
                                .select('task_id, tag_id, tags_tasks ( id, name )');

                            if (linkError) {
                                console.error('⚠️ Error linking tags:', linkError);
                                results.errors.push({
                                    type: 'tags',
                                    message: linkError.message,
                                });
                            } else {
                                results.tags = (linkedTags ?? []).map((row) => ({
                                    tagId: row.tag_id,
                                    taskId: row.task_id,
                                    tag: row.tags_tasks ?? null,
                                }));
                            }
                        }
                    }
                } catch (tagError) {
                    console.error('⚠️ Tag processing error:', tagError);
                    results.errors.push({
                        type: 'tags',
                        message: tagError.message || 'Unknown tag processing error',
                    });
                }
            }

            // Handle images - оптимизировано: параллельная обработка с батчами
            const normalizedImageUrls = Array.isArray(imageUrls) ?
                imageUrls
                .map((raw) => (typeof raw === 'string' ? raw.trim() : ''))
                .filter((url) => url.length > 0) : [];

            if (normalizedImageUrls.length > 0) {
                operations.push(
                    (async () => {
                        const moveImage = async (sourceUrl) => {
                            try {
                                const {
                                    bucket,
                                    sourcePath,
                                    fileName
                                } = parsePublicStorageUrl(sourceUrl);
                                const destinationPath = `task/${user.id}/${task.id}/${fileName}`.trim();
                                const cleanSourcePath = sourcePath.trim();
                                const cleanDestinationPath = destinationPath.trim();

                                const allowedPrefixes = [
                                    `temp/${user.id}/`,
                                ];

                                if (!allowedPrefixes.some((prefix) => cleanSourcePath.startsWith(prefix))) {
                                    console.warn('⏭ Skipping image (not user-owned path):', cleanSourcePath);
                                    return null;
                                }

                                if (cleanSourcePath !== cleanDestinationPath) {
                                    const {
                                        error: moveError
                                    } = await supabaseClient.storage
                                        .from(bucket)
                                        .move(cleanSourcePath, cleanDestinationPath);

                                    if (moveError) {
                                        console.warn('⚠️ Image move skipped:', moveError.message);
                                        return null;
                                    }
                                }

                                const {
                                    data: publicUrlData
                                } = supabaseClient.storage
                                    .from(bucket)
                                    .getPublicUrl(cleanDestinationPath);

                                if (!publicUrlData?.publicUrl) {
                                    throw new Error('Failed to retrieve public URL after move');
                                }

                                return publicUrlData.publicUrl;
                            } catch (imgErr) {
                                console.error('⚠️ Image move error:', imgErr);
                                results.errors.push({
                                    type: 'images',
                                    message: imgErr.message || 'Unknown image move error',
                                });
                                return null;
                            }
                        };

                        const settledResults = await processInBatches(normalizedImageUrls, moveImage);
                        const movedImageUrls = settledResults
                            .filter((item) => item.status === 'fulfilled' && item.value !== null)
                            .map((item) => item.value);

                        settledResults
                            .filter((item) => item.status === 'rejected')
                            .forEach((item) => {
                                results.errors.push({
                                    type: 'images',
                                    message: item.reason?.message || 'Unknown image move error',
                                });
                            });

                        if (movedImageUrls.length > 0) {
                            const imagesToInsert = movedImageUrls.map((url) => ({
                                task_id: task.id,
                                url,
                            }));

                            const {
                                data: images,
                                error: imagesError
                            } = await supabaseClient
                                .from('task_image')
                                .insert(imagesToInsert)
                                .select('id, url, created_at, task_id');

                            if (imagesError) {
                                console.error('⚠️ Error saving images:', imagesError);
                                results.errors.push({
                                    type: 'images',
                                    message: imagesError.message,
                                });
                            } else {
                                results.images = images ?? [];
                            }
                        }
                    })(),
                );
            }

            // Handle audio - параллельно
            const normalizedAudioUrls = Array.isArray(audioUrls) ?
                audioUrls
                .map((raw) => (typeof raw === 'string' ? raw.trim() : ''))
                .filter((url) => url.length > 0) : [];

            if (normalizedAudioUrls.length > 0) {
                operations.push(
                    (async () => {
                        const audioToInsert = normalizedAudioUrls.map((url) => ({
                            task_id: task.id,
                            url,
                        }));

                        const {
                            data: audio,
                            error: audioError
                        } = await supabaseClient
                            .from('task_audio')
                            .insert(audioToInsert)
                            .select('id, url, created_at, task_id');

                        if (audioError) {
                            console.error('⚠️ Error saving audio files:', audioError);
                            results.errors.push({
                                type: 'audio',
                                message: audioError.message,
                            });
                        } else {
                            results.audio = audio ?? [];
                        }
                    })(),
                );
            }

            // Handle subtasks - параллельно (normalizedSubtasks уже посчитан при создании)
            if (normalizedSubtasks.length > 0) {
                operations.push(
                    (async () => {
                        const subtasksToInsert = normalizedSubtasks.map((item) => ({
                            task_id: task.id,
                            user_id: user.id,
                            title: item.title,
                            is_completed: item.isCompleted,
                        }));

                        const {
                            data: createdSubtasks,
                            error: subtasksError
                        } = await supabaseClient
                            .from('subtasks')
                            .insert(subtasksToInsert)
                            .select('id, title, is_completed, created_at, task_id');

                        if (subtasksError) {
                            console.error('⚠️ Error saving subtasks:', subtasksError);
                            results.errors.push({
                                type: 'subtasks',
                                message: subtasksError.message,
                            });
                        } else {
                            results.subtasks = createdSubtasks ?? [];
                        }
                    })(),
                );
            }

            // Handle goal links - параллельно
            const normalizedGoalIds = Array.isArray(goalIds) ?
                Array.from(
                    new Set(
                        goalIds
                        .map((raw) => (typeof raw === 'string' ? raw.trim() : ''))
                        .filter((val) => /^[0-9a-fA-F-]{36}$/.test(val)),
                    ),
                ) : [];

            if (normalizedGoalIds.length > 0) {
                operations.push(
                    (async () => {
                        const {
                            data: existingGoals,
                            error: goalsFetchError
                        } = await supabaseClient
                            .from('goals')
                            .select('id')
                            .eq('user_id', user.id)
                            .in('id', normalizedGoalIds);

                        if (goalsFetchError) {
                            console.error('⚠️ Error fetching goals:', goalsFetchError);
                            results.errors.push({
                                type: 'goals',
                                message: goalsFetchError.message,
                            });
                        } else {
                            const validGoalIds = new Set((existingGoals ?? []).map((goal) => goal.id));
                            const invalidGoalIds = normalizedGoalIds.filter((id) => !validGoalIds.has(id));

                            if (invalidGoalIds.length > 0) {
                                results.errors.push({
                                    type: 'goals',
                                    message: `Some goals do not belong to the user or do not exist: ${invalidGoalIds.join(', ')}`,
                                });
                            }

                            if (validGoalIds.size > 0) {
                                const goalLinks = Array.from(validGoalIds).map((goalId) => ({
                                    goal_id: goalId,
                                    task_id: task.id,
                                }));

                                const {
                                    data: linkedGoals,
                                    error: linkGoalsError
                                } = await supabaseClient
                                    .from('task_goals')
                                    .insert(goalLinks)
                                    .select('goal_id, task_id');

                                if (linkGoalsError) {
                                    console.error('⚠️ Error linking goals:', linkGoalsError);
                                    results.errors.push({
                                        type: 'goals',
                                        message: linkGoalsError.message,
                                    });
                                } else {
                                    results.goals = linkedGoals ?? [];
                                }
                            }
                        }
                    })(),
                );
            }

        }

        // Выполняем все независимые операции параллельно
        if (operations.length > 0) {
            await Promise.allSettled(operations);
        }

        console.log(isUpdate ? '✅ Task updated successfully:' : '✅ Task created successfully:', task.id);

        try {
            console.log('🎁 Triggering task reward calculation...');
            const rewardResponse = await fetch(
                `${Deno.env.get('SUPABASE_URL')}/functions/v1/triger-task-reward`, {
                    method: 'POST',
                    headers: {
                        Authorization: req.headers.get('Authorization') ?? '',
                        'Content-Type': 'application/json',
                        apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
                    },
                    body: JSON.stringify({
                        user_id: user.id
                    }),
                },
            );

            if (!rewardResponse.ok) {
                console.warn('⚠️ Task reward calculation failed, but task saved');
            } else {
                console.log('✅ Task reward calculation triggered successfully');
            }
        } catch (rewardError) {
            console.warn('⚠️ Failed to trigger task rewards:', rewardError.message);
        }

        results.endDate = results.endDate ?? task?.end_date ?? taskPayload?.end_date ?? null;
        if (results.task && typeof results.task === 'object') {
            results.task.endDate = results.endDate;
        }

        return new Response(
            JSON.stringify({
                success: true,
                data: results,
                message: 'Task saved successfully',
            }), {
                status: 200,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json',
                },
            },
        );

    } catch (error) {
        console.error('❌ Error:', error);

        return new Response(
            JSON.stringify({
                success: false,
                error: error.message ?? 'An unknown error occurred',
                message: 'Failed to save task',
            }), {
                status: error.message?.includes('not authenticated') ? 401 : 500,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json',
                },
            },
        );
    }
});