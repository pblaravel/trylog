import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function for retrieving user statistics
 * 
 * Returns:
 * - count_journal: number of journals in the current year
 * - count_words: total word count in descriptions of all journals for the current year
 * - count_days: number of unique days with entries in the current year
 * - new_location: number of locations created today
 * - new_tags: number of tags created today
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

    console.log(`📊 Fetching statistics for user: ${user.id}`);

    // Calculate start of current year (January 1st of current year)
    const now = new Date();
    const currentYearStart = new Date(now.getFullYear(), 0, 1);
    const currentYearStartISO = currentYearStart.toISOString();

    console.log(`📅 Fetching data from: ${currentYearStartISO}`);

    // Fetch all user journals from the current year
    const { data: journals, error: journalsError } = await supabaseClient
      .from('journal')
      .select('id, description, created_at')
      .eq('user_id', user.id)
      .gte('created_at', currentYearStartISO)
      .order('created_at', { ascending: false });

    if (journalsError) {
      console.error('❌ Error fetching journals:', journalsError);
      throw new Error(`Failed to fetch journals: ${journalsError.message}`);
    }

    console.log(`✅ Found ${journals?.length || 0} journals`);

    // 1. Count number of journals
    const count_journal = journals?.length || 0;

    // 2. Count total words in descriptions
    let count_words = 0;
    if (journals && journals.length > 0) {
      for (const journal of journals) {
        if (journal.description && journal.description.trim() !== '') {
          // Split text into words (by spaces and punctuation)
          const words = journal.description
            .trim()
            .split(/\s+/)
            .filter((word) => word.length > 0);
          count_words += words.length;
        }
      }
    }

    // 3. Count unique days with entries in current year
    let count_days = 0;
    if (journals && journals.length > 0) {
      const uniqueDates = new Set();
      
      for (const journal of journals) {
        if (journal.created_at) {
          // Extract only date (without time) in YYYY-MM-DD format
          const dateOnly = journal.created_at.split('T')[0];
          uniqueDates.add(dateOnly);
        }
      }
      
      count_days = uniqueDates.size;
    }

    // 4. Count new locations created today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartISO = todayStart.toISOString();

    const { data: locationsToday, error: locationsError } = await supabaseClient
      .from('locations')
      .select('id')
      .eq('user_id', user.id)
      .gte('created_at', todayStartISO);

    const new_location = locationsToday?.length || 0;

    if (locationsError) {
      console.warn('⚠️ Error fetching locations:', locationsError);
    }

    // 5. Count new tags created today
    const { data: tagsToday, error: tagsError } = await supabaseClient
      .from('tags')
      .select('id')
      .eq('user_id', user.id)
      .gte('created_at', todayStartISO);

    const new_tags = tagsToday?.length || 0;

    if (tagsError) {
      console.warn('⚠️ Error fetching tags:', tagsError);
    }

    console.log(`📈 Statistics calculated:`);
    console.log(`   - Journals: ${count_journal}`);
    console.log(`   - Words: ${count_words}`);
    console.log(`   - Days: ${count_days}`);
    console.log(`   - New Locations Today: ${new_location}`);
    console.log(`   - New Tags Today: ${new_tags}`);

    // Return result
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          count_journal,
          count_words,
          count_days,
          new_location,
          new_tags,
          period: {
            from: currentYearStartISO,
            to: new Date().toISOString(),
          },
          today: todayStartISO,
        },
        message: 'Statistics retrieved successfully',
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
        message: 'Failed to retrieve statistics',
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

