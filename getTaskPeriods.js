import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function for retrieving all unique task dates
 * 
 * Returns object with:
 * - uniqueDatesArray: array of unique dates (YYYY-MM-DD) sorted descending for all tasks in database
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

    console.log(`📊 Fetching all task dates for user: ${user.id}`);

    // Fetch all user tasks
    const { data: tasks, error: tasksError } = await supabaseClient
      .from('tasks')
      .select('created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (tasksError) {
      console.error('❌ Error fetching tasks:', tasksError);
      throw new Error(`Failed to fetch tasks: ${tasksError.message}`);
    }

    console.log(`✅ Found ${tasks?.length || 0} tasks`);

    // Initialize results
    const stats = {
      uniqueDatesArray: [],
    };

    if (!tasks || tasks.length === 0) {
      console.log('📭 No tasks found for statistics calculation');
      return new Response(
        JSON.stringify({
          success: true,
          data: stats,
          message: 'No tasks found',
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

    // Collect unique dates
    const uniqueDates = new Set();
    for (const task of tasks) {
      if (task.created_at) {
        const dateOnly = task.created_at.split('T')[0];
        uniqueDates.add(dateOnly);
      }
    }
    
    // Convert Set to Array and sort descending
    stats.uniqueDatesArray = Array.from(uniqueDates).sort((a, b) => {
      return b.localeCompare(a); // descending order
    });

    console.log(`📈 Unique dates calculated: ${stats.uniqueDatesArray.length}`);

    // Return result
    return new Response(
      JSON.stringify({
        success: true,
        data: stats,
        message: 'Task dates retrieved successfully',
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
        message: 'Failed to retrieve task statistics',
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

