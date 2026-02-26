import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function for calculating and awarding rewards for tasks
 * 
 * New Reward Types Logic:
 * 
 * Early Wins:
 * - first-completed-task: Complete first task
 * - first-goal-created: Create first goal
 * - task-linked-to-goal: Link task to goal
 * - first-media-attached: First media attached
 * - first-voice-note: First voice note left
 * 
 * Momentum (Streaks):
 * - streak-days: Consecutive days with completed tasks (2, 3, 7, 10)
 * 
 * Consistency:
 * - total-completed-tasks: Total completed tasks (3, 10, 25, 50)
 * - days-in-week: Complete tasks on N different days in a week (5)
 * - days-in-month: Complete tasks on N different days in a month (20)
 * 
 * Rhythm (Goals):
 * - first-goal-completed: Complete first goal
 * - goals-completed: Total completed goals (3)
 * - tasks-linked-to-goals: Total tasks linked to goals (5)
 * - goal-80-percent: Goal achieved with 80%+ goal tasks completed
 * 
 * Intention:
 * - total-words: Total words in task descriptions (100, 500)
 * - total-images: Total images across tasks (3)
 * - total-audio: Total audio files across tasks (3)
 * 
 * Tables used:
 * - rewards_tasks: available rewards
 * - rewards_users_tasks: user's earned rewards progress
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

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      throw new Error('User not authenticated');
    }

    let targetUserId = user.id;
    try {
      const body = await req.json();
      if (body.user_id && typeof body.user_id === 'string') {
        targetUserId = body.user_id;
      }
    } catch {
      // No body or invalid JSON, use current user
    }

    console.log(`🎁 Calculating task rewards for user: ${targetUserId}`);

    // ===== STEP 1: Fetch all user data =====
    const { data: tasks, error: tasksError } = await supabaseClient
      .from('tasks')
      .select('id, is_completed, updated_at, created_at, description')
      .eq('user_id', targetUserId)
      .order('created_at', { ascending: false });

    if (tasksError) {
      console.error('❌ Error fetching tasks:', tasksError);
      throw new Error(`Failed to fetch tasks: ${tasksError.message}`);
    }

    const { data: goals, error: goalsError } = await supabaseClient
      .from('goals')
      .select('id, created_at')
      .eq('user_id', targetUserId);

    if (goalsError) {
      console.error('❌ Error fetching goals:', goalsError);
      throw new Error(`Failed to fetch goals: ${goalsError.message}`);
    }

    const { data: taskGoals, error: taskGoalsError } = await supabaseClient
      .from('task_goals')
      .select('goal_id, task_id, tasks:tasks!inner(id, is_completed)')
      .eq('tasks.user_id', targetUserId);

    if (taskGoalsError) {
      console.error('❌ Error fetching task-goals:', taskGoalsError);
      throw new Error(`Failed to fetch task-goals: ${taskGoalsError.message}`);
    }

    const taskIds = tasks?.map(t => t.id) || [];
    
    const { data: images, error: imagesError } = await supabaseClient
      .from('task_image')
      .select('id, task_id, created_at')
      .in('task_id', taskIds.length > 0 ? taskIds : ['00000000-0000-0000-0000-000000000000']);

    const { data: audio, error: audioError } = await supabaseClient
      .from('task_audio')
      .select('id, task_id, created_at')
      .in('task_id', taskIds.length > 0 ? taskIds : ['00000000-0000-0000-0000-000000000000']);

    console.log(`✅ Found ${tasks?.length || 0} tasks, ${goals?.length || 0} goals, ${images?.length || 0} images, ${audio?.length || 0} audio`);

    // ===== STEP 2: Calculate all metrics =====
    
    // Helper function to format date
    const formatDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    // Count words in text
    const countWords = (text) => {
      if (!text || text.trim() === '') return 0;
      return text.trim().split(/\s+/).filter(word => word.length > 0).length;
    };

    // Calculate streak days
    const completedDates = new Set();
    for (const task of tasks || []) {
      if (task.is_completed && task.updated_at) {
        const dateOnly = task.updated_at.split('T')[0];
        completedDates.add(dateOnly);
      }
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = formatDate(today);

    let currentDate;
    if (completedDates.has(todayStr)) {
      currentDate = new Date(today);
    } else {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      currentDate = new Date(yesterday);
    }

    let streakDays = 0;
    while (true) {
      const dateStr = formatDate(currentDate);
      if (completedDates.has(dateStr)) {
        streakDays++;
        currentDate.setDate(currentDate.getDate() - 1);
      } else {
        break;
      }
    }

    // Calculate days in current week (last 7 days)
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const daysInWeek = new Set();
    for (const task of tasks || []) {
      if (task.is_completed && task.updated_at) {
        const taskDate = new Date(task.updated_at);
        if (taskDate >= weekAgo) {
          daysInWeek.add(formatDate(taskDate));
        }
      }
    }

    // Calculate days in current month
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const daysInMonth = new Set();
    for (const task of tasks || []) {
      if (task.is_completed && task.updated_at) {
        const taskDate = new Date(task.updated_at);
        if (taskDate >= monthStart) {
          daysInMonth.add(formatDate(taskDate));
        }
      }
    }

    // Count completed tasks
    const totalCompletedTasks = (tasks || []).filter(t => t.is_completed).length;

    // Count total words
    const totalWords = (tasks || []).reduce((sum, t) => sum + countWords(t.description), 0);

    // Count goals completed (goals with 100% completion)
    const goalIds = (goals || []).map(g => g.id);
    let completedGoalsCount = 0;
    if (goalIds.length > 0) {
      // Group tasks by goals
      const tasksByGoal = new Map();
      const allTaskIdsForGoals = new Set();
      (taskGoals || []).forEach((tg) => {
        if (!tg.tasks) return;
        const goalId = tg.goal_id;
        const taskId = tg.tasks.id;
        allTaskIdsForGoals.add(taskId);
        if (!tasksByGoal.has(goalId)) {
          tasksByGoal.set(goalId, []);
        }
        tasksByGoal.get(goalId).push(tg.tasks);
      });

      // Get subtasks for goal tasks
      const taskIdsArray = Array.from(allTaskIdsForGoals);
      let subtasksByTask = new Map();
      if (taskIdsArray.length > 0) {
        const { data: subtasks } = await supabaseClient
          .from('subtasks')
          .select('id, task_id, is_completed')
          .in('task_id', taskIdsArray)
          .eq('user_id', targetUserId);

        (subtasks || []).forEach((subtask) => {
          const taskId = subtask.task_id;
          if (!subtasksByTask.has(taskId)) {
            subtasksByTask.set(taskId, []);
          }
          subtasksByTask.get(taskId).push(subtask);
        });
      }

      // Calculate completion for each goal
      for (const goalId of goalIds) {
        const goalTasks = tasksByGoal.get(goalId) || [];
        let totalItems = goalTasks.length;
        let completedItems = goalTasks.filter((t) => t.is_completed).length;

        goalTasks.forEach((task) => {
          const subtasks = subtasksByTask.get(task.id) || [];
          totalItems += subtasks.length;
          completedItems += subtasks.filter((st) => st.is_completed).length;
        });

        const completionPercentage = totalItems > 0 
          ? Math.round((completedItems / totalItems) * 100) 
          : 100;
        
        if (completionPercentage === 100) {
          completedGoalsCount++;
        }
      }
    }

    // Count tasks linked to goals
    const tasksLinkedToGoals = new Set((taskGoals || []).map(tg => tg.task_id)).size;

    // Check for goals with 80%+ completion
    let goalsWith80Percent = 0;
    if (goalIds.length > 0) {
      const tasksByGoal = new Map();
      const allTaskIdsForGoals = new Set();
      (taskGoals || []).forEach((tg) => {
        if (!tg.tasks) return;
        const goalId = tg.goal_id;
        const taskId = tg.tasks.id;
        allTaskIdsForGoals.add(taskId);
        if (!tasksByGoal.has(goalId)) {
          tasksByGoal.set(goalId, []);
        }
        tasksByGoal.get(goalId).push(tg.tasks);
      });

      const taskIdsArray = Array.from(allTaskIdsForGoals);
      let subtasksByTask = new Map();
      if (taskIdsArray.length > 0) {
        const { data: subtasks } = await supabaseClient
          .from('subtasks')
          .select('id, task_id, is_completed')
          .in('task_id', taskIdsArray)
          .eq('user_id', targetUserId);

        (subtasks || []).forEach((subtask) => {
          const taskId = subtask.task_id;
          if (!subtasksByTask.has(taskId)) {
            subtasksByTask.set(taskId, []);
          }
          subtasksByTask.get(taskId).push(subtask);
        });
      }

      for (const goalId of goalIds) {
        const goalTasks = tasksByGoal.get(goalId) || [];
        let totalItems = goalTasks.length;
        let completedItems = goalTasks.filter((t) => t.is_completed).length;

        goalTasks.forEach((task) => {
          const subtasks = subtasksByTask.get(task.id) || [];
          totalItems += subtasks.length;
          completedItems += subtasks.filter((st) => st.is_completed).length;
        });

        const completionPercentage = totalItems > 0 
          ? Math.round((completedItems / totalItems) * 100) 
          : 100;
        
        if (completionPercentage >= 80) {
          goalsWith80Percent++;
        }
      }
    }

    // Check firsts
    const hasFirstCompletedTask = totalCompletedTasks >= 1;
    const hasFirstGoalCreated = (goals || []).length >= 1;
    const hasTaskLinkedToGoal = tasksLinkedToGoals >= 1;
    const hasFirstMedia = (images?.length || 0) >= 1;
    const hasFirstVoiceNote = (audio?.length || 0) >= 1;
    const hasFirstGoalCompleted = completedGoalsCount >= 1;

    console.log(`📊 Metrics calculated:`);
    console.log(`   Streak days: ${streakDays}`);
    console.log(`   Completed tasks: ${totalCompletedTasks}`);
    console.log(`   Days in week: ${daysInWeek.size}`);
    console.log(`   Days in month: ${daysInMonth.size}`);
    console.log(`   Total words: ${totalWords}`);
    console.log(`   Total images: ${images?.length || 0}`);
    console.log(`   Total audio: ${audio?.length || 0}`);
    console.log(`   Goals completed: ${completedGoalsCount}`);
    console.log(`   Tasks linked to goals: ${tasksLinkedToGoals}`);
    console.log(`   Goals with 80%+: ${goalsWith80Percent}`);

    // ===== STEP 3: Get all available rewards =====
    const { data: allRewards, error: rewardsError } = await supabaseClient
      .from('rewards_tasks')
      .select('id, name, type, count, category, img')
      .order('count', { ascending: true });

    if (rewardsError) {
      console.error('❌ Error fetching rewards:', rewardsError);
      throw new Error(`Failed to fetch rewards: ${rewardsError.message}`);
    }

    console.log(`✅ Found ${allRewards?.length || 0} available rewards`);

    // ===== STEP 4: Fetch existing progress =====
    const { data: existingRows, error: existingError } = await supabaseClient
      .from('rewards_users_tasks')
      .select('id, rewards_id, count, finish')
      .eq('user_id', targetUserId);

    if (existingError) {
      console.error('❌ Error fetching existing rewards:', existingError);
      throw new Error(`Failed to fetch existing rewards: ${existingError.message}`);
    }

    const existingByRewardId = new Map((existingRows || []).map(r => [r.rewards_id, r]));

    // ===== STEP 5: Calculate and update progress for each reward =====
    let upserts = 0;
    let updates = 0;

    for (const reward of allRewards || []) {
      let progress = 0;
      let shouldTrack = false;

      // Calculate progress based on reward type
      switch (reward.type) {
        // Early Wins
        case 'first-completed-task':
          progress = hasFirstCompletedTask ? 1 : 0;
          shouldTrack = hasFirstCompletedTask;
          break;
        case 'first-goal-created':
          progress = hasFirstGoalCreated ? 1 : 0;
          shouldTrack = hasFirstGoalCreated;
          break;
        case 'task-linked-to-goal':
          progress = hasTaskLinkedToGoal ? 1 : 0;
          shouldTrack = hasTaskLinkedToGoal;
          break;
        case 'first-media-attached':
          progress = hasFirstMedia ? 1 : 0;
          shouldTrack = hasFirstMedia;
          break;
        case 'first-voice-note':
          progress = hasFirstVoiceNote ? 1 : 0;
          shouldTrack = hasFirstVoiceNote;
          break;

        // Momentum
        case 'streak-days':
          progress = streakDays;
          shouldTrack = streakDays > 0;
          break;

        // Consistency
        case 'total-completed-tasks':
          progress = totalCompletedTasks;
          shouldTrack = totalCompletedTasks > 0;
          break;
        case 'days-in-week':
          progress = daysInWeek.size;
          shouldTrack = daysInWeek.size > 0;
          break;
        case 'days-in-month':
          progress = daysInMonth.size;
          shouldTrack = daysInMonth.size > 0;
          break;

        // Rhythm
        case 'first-goal-completed':
          progress = hasFirstGoalCompleted ? 1 : 0;
          shouldTrack = hasFirstGoalCompleted;
          break;
        case 'goals-completed':
          progress = completedGoalsCount;
          shouldTrack = completedGoalsCount > 0;
          break;
        case 'tasks-linked-to-goals':
          progress = tasksLinkedToGoals;
          shouldTrack = tasksLinkedToGoals > 0;
          break;
        case 'goal-80-percent':
          progress = goalsWith80Percent;
          shouldTrack = goalsWith80Percent > 0;
          break;

        // Intention
        case 'total-words':
          progress = totalWords;
          shouldTrack = totalWords > 0;
          break;
        case 'total-images':
          progress = images?.length || 0;
          shouldTrack = (images?.length || 0) > 0;
          break;
        case 'total-audio':
          progress = audio?.length || 0;
          shouldTrack = (audio?.length || 0) > 0;
          break;

        default:
          console.log(`⚠️ Unknown reward type: ${reward.type}`);
          continue;
      }

      if (!shouldTrack) continue;

      const finish = typeof reward.count === 'number' && reward.count > 0 
        ? progress >= reward.count 
        : false;

      const existing = existingByRewardId.get(reward.id);
      if (existing) {
        if (existing.finish) continue; // Already finished, skip
        const newCount = Math.max(Number(existing.count || 0), Number(progress));
        const newFinish = finish;
        const needUpdate = newCount !== Number(existing.count || 0) || newFinish !== existing.finish;
        
        if (!needUpdate) {
          console.log(`⏭️ Skip update: ${reward.name} unchanged (count=${existing.count}, finish=${existing.finish})`);
        } else {
          const { error: updateError } = await supabaseClient
            .from('rewards_users_tasks')
            .update({ count: newCount, finish: newFinish })
            .eq('id', existing.id);
          
          if (updateError) {
            console.error(`⚠️ Error updating reward ${reward.name}:`, updateError);
            continue;
          }
          updates++;
          console.log(`🔁 Updated reward progress: ${reward.name} -> count=${newCount}, finish=${newFinish}`);
        }
      } else {
        const { error: insertError } = await supabaseClient
          .from('rewards_users_tasks')
          .insert({
            user_id: targetUserId,
            rewards_id: reward.id,
            finish,
            count: progress,
          });
        
        if (insertError) {
          console.error(`⚠️ Error inserting reward ${reward.name}:`, insertError);
          continue;
        }
        upserts++;
        console.log(`🆕 Inserted reward progress: ${reward.name} -> count=${progress}, finish=${finish}`);
      }
    }

    console.log(`✅ Progress saved. inserted=${upserts}, updated=${updates}`);

    // Return simple success result
    return new Response(
      JSON.stringify({
        success: true,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    console.error('❌ Error:', error);
    
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || 'An unknown error occurred',
      }),
      {
        status: error.message?.includes('not authenticated') ? 401 : 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
