import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function for calculating and awarding rewards
 * 
 * Called after creating a new journal entry
 * 
 * Logic:
 * 1. Calculates current user streak
 * 2. Counts total journals and media
 * 3. Checks which rewards are earned (from rewards table)
 * 4. Records new rewards in rewards_users table (if not already received)
 * 
 * Reward types:
 * - daily: based on daily_streaks (consecutive days)
 * - weekly: based on weekly_streaks (daily_streaks / 7)
 * - journal: based on total journals count
 * - media: based on total media count (images + audio)
 * 
 * Tables used:
 * - journal: to get user's journal entries (user_id, created_at)
 * - journal_image: to count user's images
 * - journal_audio: to count user's audio files
 * - rewards: to get available rewards (id, name, type, count, img)
 * - rewards_users: to store user's earned rewards (user_id, rewards_id)
 * 
 * Accepts JSON (optional):
 * - user_id - User ID for reward calculation (if not provided, uses current user)
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

    // Get user_id from body or use current user
    let targetUserId = user.id;
    
    if (req.method === 'POST') {
      try {
        const body = await req.json();
        if (body.user_id) {
          targetUserId = body.user_id;
        }
      } catch (e) {
        // If no body, use current user
      }
    }

    console.log(`🎁 Calculating rewards for user: ${targetUserId}`);

    // ===== STEP 1: Get all user's journal entries =====
    const { data: journals, error: journalsError } = await supabaseClient
      .from('journal')
      .select('id, created_at')
      .eq('user_id', targetUserId)
      .order('created_at', { ascending: false });

    if (journalsError) {
      console.error('❌ Error fetching journals:', journalsError);
      throw new Error(`Failed to fetch journals: ${journalsError.message}`);
    }

    console.log(`✅ Found ${journals?.length || 0} journals`);

    if (!journals || journals.length === 0) {
      console.log('📭 No journals found, no rewards to give');
      return new Response(
        JSON.stringify({
          success: true,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // ===== STEP 2: Calculate streak =====
    const uniqueDates = new Set();
    for (const journal of journals) {
      if (journal.created_at) {
        const dateOnly = journal.created_at.split('T')[0];
        uniqueDates.add(dateOnly);
      }
    }

    const formatDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = formatDate(today);

    // Determine starting date for streak calculation
    // If today has a journal - start from today, otherwise from yesterday
    let currentDate;
    if (uniqueDates.has(todayStr)) {
      currentDate = new Date(today);
      console.log(`📅 Starting streak from today (${todayStr})`);
    } else {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      currentDate = new Date(yesterday);
      console.log(`📅 Starting streak from yesterday`);
    }

    let daily_streaks = 0;
    while (true) {
      const dateStr = formatDate(currentDate);
      if (uniqueDates.has(dateStr)) {
        daily_streaks++;
        currentDate.setDate(currentDate.getDate() - 1);
      } else {
        break;
      }
    }

    const weekly_streaks = Math.floor(daily_streaks / 7);

    console.log(`🔥 Streaks calculated: daily=${daily_streaks}, weekly=${weekly_streaks}`);

    // ===== STEP 3: Count total journals and media =====
    const total_journals = journals.length;
    
    // Count total media (images + audio) for this user
    const { data: images, error: imagesError } = await supabaseClient
      .from('journal_image')
      .select('id')
      .in('journal_id', journals.map(j => j.id));
    
    const { data: audio, error: audioError } = await supabaseClient
      .from('journal_audio')
      .select('id')
      .in('journal_id', journals.map(j => j.id));
    
    const total_images = images?.length || 0;
    const total_audio = audio?.length || 0;
    
    console.log(`📊 Totals: journals=${total_journals}, images=${total_images}, audio=${total_audio}`);

    // ===== STEP 4: Get all available rewards from rewards table =====
    const { data: allRewards, error: rewardsError } = await supabaseClient
      .from('rewards')
      .select('id, name, type, count, category, img')
      .order('count', { ascending: true });

    if (rewardsError) {
      console.error('❌ Error fetching rewards:', rewardsError);
      throw new Error(`Failed to fetch rewards: ${rewardsError.message}`);
    }

    console.log(`✅ Found ${allRewards?.length || 0} available rewards`);

    // ===== STEP 5: Create/Update rewards progress per reward =====
    // Progress per type: daily -> daily_streaks, weekly -> weekly_streaks, journal -> total_journals, media -> total_media

    // Fetch existing rows to decide update vs insert
    const { data: existingRows, error: existingError } = await supabaseClient
      .from('rewards_users')
      .select('id, rewards_id, count, finish')
      .eq('user_id', targetUserId);

    if (existingError) {
      console.error('❌ Error fetching existing rewards:', existingError);
      throw new Error(`Failed to fetch existing rewards: ${existingError.message}`);
    }

    const existingByRewardId = new Map((existingRows || []).map(r => [r.rewards_id, r]));

    let upserts = 0;
    let updates = 0;
    
    for (const reward of allRewards || []) {
      let progress = 0;
      if (reward.type === 'daily') progress = daily_streaks;
      else if (reward.type === 'weekly') progress = weekly_streaks;
      else if (reward.type === 'journal') progress = total_journals;
      else if (reward.type === 'image') progress = total_images;
      else if (reward.type === 'audio') progress = total_audio;
      // Отдельная логика для наград категории entry-count: считаем общее количество записей, а не стрики
      if (reward.category === 'entry-count') {
        progress = total_journals;
      }

      if (progress <= 0) continue; // пишем только если есть прогресс

      const finish = typeof reward.count === 'number' && reward.count > 0 ? progress >= reward.count : false;

      const existing = existingByRewardId.get(reward.id);
      if (existing) {
        if (existing.finish) continue;
        const newCount = Math.max(Number(existing.count || 0), Number(progress));
        const newFinish = finish;
        const needUpdate = newCount !== existing.count || newFinish !== existing.finish;
        if (!needUpdate) {
          console.log(`⏭️ Skip update: ${reward.name} unchanged (count=${existing.count}, finish=${existing.finish})`);
        } else {
          const { error: updateError } = await supabaseClient
            .from('rewards_users')
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
          .from('rewards_users')
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
      }),
      {
        status: error.message?.includes('not authenticated') ? 401 : 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
