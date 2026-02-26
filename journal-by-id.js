import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Supabase Edge Function for retrieving a journal entry by ID
 * 
 * Returns complete journal data including:
 * - Basic journal information
 * - Images (journal_image)
 * - Audio files (journal_audio)
 * - Tags (tags via journal_tag)
 * - Location (locations via journal_location)
 * 
 * Usage:
 * GET /journal-by-id?id={journal_id}
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

    // Get journal ID from query params
    const url = new URL(req.url);
    const journalId = url.searchParams.get('id');

    if (!journalId || journalId.trim() === '') {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Journal ID is required',
          message: 'Please provide a journal ID in the query parameter: ?id={journal_id}',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    console.log(`📖 Fetching journal ${journalId} for user: ${user.id}`);

    // 1. Fetch main journal entry
    const { data: journal, error: journalError } = await supabaseClient
      .from('journal')
      .select('id, user_id, title, description, title_image, created_at, is_favorite')
      .eq('id', journalId)
      .eq('user_id', user.id)
      .single();

    if (journalError) {
      if (journalError.code === 'PGRST116') {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Journal not found',
            message: 'The requested journal does not exist or you do not have access to it',
          }),
          {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }
      console.error('❌ Error fetching journal:', journalError);
      throw new Error(`Failed to fetch journal: ${journalError.message}`);
    }

    console.log(`✅ Journal found: ${journal.title}`);

    // 2. Fetch images
    const { data: images, error: imagesError } = await supabaseClient
      .from('journal_image')
      .select('id, url, created_at')
      .eq('journal_id', journalId)
      .order('created_at', { ascending: true });

    if (imagesError) {
      console.error('⚠️ Error fetching images:', imagesError);
    }

    // 3. Fetch audio files
    const { data: audio, error: audioError } = await supabaseClient
      .from('journal_audio')
      .select('id, url, created_at')
      .eq('journal_id', journalId)
      .order('created_at', { ascending: true });

    if (audioError) {
      console.error('⚠️ Error fetching audio:', audioError);
    }

    // 4. Fetch tags
    const { data: journalTags, error: tagsError } = await supabaseClient
      .from('journal_tag')
      .select('tag_id, tags(id, name)')
      .eq('journal_id', journalId);

    let tags = [];
    if (tagsError) {
      console.error('⚠️ Error fetching tags:', tagsError);
    } else if (journalTags) {
      tags = journalTags
        .filter((jt) => jt.tags)
        .map((jt) => ({
          id: jt.tags.id,
          name: jt.tags.name,
        }));
    }

    // 5. Fetch location
    const { data: journalLocation, error: locationError } = await supabaseClient
      .from('journal_location')
      .select('location_id, locations(id, city, state)')
      .eq('journal_id', journalId)
      .single();

    let location = null;
    if (locationError) {
      if (locationError.code !== 'PGRST116') {
        console.error('⚠️ Error fetching location:', locationError);
      }
    } else if (journalLocation && journalLocation.locations) {
      location = {
        id: journalLocation.locations.id,
        city: journalLocation.locations.city,
        state: journalLocation.locations.state,
      };
    }

    console.log(`📊 Data fetched: ${images?.length || 0} images, ${audio?.length || 0} audio, ${tags.length} tags`);

    // Build complete response in the same format as journal-pagination
    const result = {
      id: journal.id,
      title: journal.title,
      description: journal.description,
      tags: tags,
      countMedia: (images?.length || 0) + (audio?.length || 0),
      location: location,
      titleImage: journal.title_image,
      createdAt: journal.created_at,
      isFavorite: journal.is_favorite,
      images: (images || []).map((img) => ({
        id: img.id,
        url: img.url,
        createdAt: img.created_at,
      })),
      audio: (audio || []).map((aud) => ({
        id: aud.id,
        url: aud.url,
        createdAt: aud.created_at,
      })),
    };

    console.log('🎉 Journal data retrieved successfully!');

    // Return result
    return new Response(
      JSON.stringify({
        success: true,
        data: result,
        message: 'Journal retrieved successfully',
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
        message: 'Failed to retrieve journal',
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

