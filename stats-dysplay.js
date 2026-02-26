import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function for retrieving extended user statistics
 * 
 * Returns object with:
 * - journal: {total, year, month} - count of entries (total: all time, year: current year, month: current month)
 * - words: {total, year, month} - word count from description (total: all time, year: current year, month: current month)
 * - days: {total, year, month} - count of unique days with entries (total: all time, year: current year, month: current month)
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

    console.log(`📊 Fetching extended statistics for user: ${user.id}`);

    // Calculate dates for filtering
    const now = new Date();
    
    // Current year start (January 1st of current year)
    const currentYearStart = new Date(now.getFullYear(), 0, 1);
    const currentYearStartISO = currentYearStart.toISOString();
    
    // Current month start
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const currentMonthStartISO = currentMonthStart.toISOString();

    console.log(`📅 Periods - All time, Year from: ${currentYearStartISO}, Month from: ${currentMonthStartISO}`);

    // Fetch all user journals (all time)
    const { data: allJournals, error: journalsError } = await supabaseClient
      .from('journal')
      .select('id, description, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (journalsError) {
      console.error('❌ Error fetching journals:', journalsError);
      throw new Error(`Failed to fetch journals: ${journalsError.message}`);
    }

    console.log(`✅ Found ${allJournals?.length || 0} entries`);

    // Initialize results
    const stats = {
      journal: { total: 0, year: 0, month: 0 },
      words: { total: 0, year: 0, month: 0 },
      days: { total: 0, year: 0, month: 0 },
    };

    if (!allJournals || allJournals.length === 0) {
      console.log('📭 No entries found for statistics calculation');
      return new Response(
        JSON.stringify({
          success: true,
          data: stats,
          message: 'No journals found',
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

    // Filter journals by periods
    const journalsYear = allJournals.filter(j => 
      new Date(j.created_at) >= currentYearStart
    );
    
    const journalsMonth = allJournals.filter(j => 
      new Date(j.created_at) >= currentMonthStart
    );

    // Function to count words in text
    const countWords = (text) => {
      if (!text || text.trim() === '') return 0;
      const words = text.trim().split(/\s+/).filter(word => word.length > 0);
      return words.length;
    };

    const uniqueDates = new Set();
    // Function to count unique days
    const countUniqueDays = (journals) => {
      for (const journal of journals) {
        if (journal.created_at) {
          const dateOnly = journal.created_at.split('T')[0];
          uniqueDates.add(dateOnly);
        }
      }
      return uniqueDates.size;
    };

    // Calculate statistics for all entries (total)
    stats.journal.total = allJournals.length;
    stats.words.total = allJournals.reduce((sum, j) => sum + countWords(j.description), 0);
    stats.days.total = countUniqueDays(allJournals);

    // Calculate statistics for current year (year)
    stats.journal.year = journalsYear.length;
    stats.words.year = journalsYear.reduce((sum, j) => sum + countWords(j.description), 0);
    stats.days.year = countUniqueDays(journalsYear);

    // Calculate statistics for current month (month)
    stats.journal.month = journalsMonth.length;
    stats.words.month = journalsMonth.reduce((sum, j) => sum + countWords(j.description), 0);
    stats.days.month = countUniqueDays(journalsMonth);

    console.log(`📈 Statistics calculated:`);
    console.log(`   Journals - Total: ${stats.journal.total}, Year: ${stats.journal.year}, Month: ${stats.journal.month}`);
    console.log(`   Words - Total: ${stats.words.total}, Year: ${stats.words.year}, Month: ${stats.words.month}`);
    console.log(`   Days - Total: ${stats.days.total}, Year: ${stats.days.year}, Month: ${stats.days.month}`);

    // Return result
    return new Response(
      JSON.stringify({
        success: true,
        data: stats,
        message: 'Statistics retrieved successfully',
        periods: {
          total: 'All time',
          year: `From ${currentYearStartISO}`,
          month: `From ${currentMonthStartISO}`,
          uniqueDatesArray: Array.from(uniqueDates),
        },
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

