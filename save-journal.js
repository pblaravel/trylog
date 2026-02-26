import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

  return { bucket, sourcePath, fileName };
};

/**
 * Supabase Edge Function for saving journal entries
 * 
 * Accepts JSON with the following fields:
 * - title (required)
 * - description
 * - titleImage
 * - isFavorite
 * - imageUrls (array of image URLs)
 * - audioUrls (array of audio URLs)
 * - tags (array of tag names as strings, e.g. ["Creativity", "Work"])
 * - location (object with city and state, e.g. {city: "San Francisco", state: "CA"})
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

    // Parse JSON from request
    const {
      title,
      description = null,
      titleImage = null,
      isFavorite = false,
      imageUrls = [],
      audioUrls = [],
      tags = [],
      location = null,
    } = await req.json();

    // Validation
    if (!title || title.trim() === '') {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Journal title is required',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    console.log(`📝 Creating journal entry for user: ${user.id}`);

    // 1. Create main journal entry
    const { data: journal, error: journalError } = await supabaseClient
      .from('journal')
      .insert({
        title: title.trim(),
        description: description?.trim() || null,
        title_image: titleImage,
        is_favorite: isFavorite,
      })
      .select('id, user_id, title, description, title_image, created_at, is_favorite')
      .single();

    if (journalError) {
      console.error('❌ Error creating journal entry:', journalError);
      throw new Error(`Failed to create journal entry: ${journalError.message}`);
    }

    console.log(`✅ Journal entry created with ID: ${journal.id}`);

    // Operation results
    const results = {
      journal,
      images: [],
      audio: [],
      tags: [],
      location: null,
      errors: [],
    };

    const addError = (type, message) => {
      results.errors.push({
        type,
        message,
      });
    };

    const operations = [];

    // 2. Move existing public images into journal/{user.id}/{journal.id}/filename.ext and save records
    if (imageUrls.length > 0) {
      operations.push(
        (async () => {
          const moveImage = async (sourceUrl) => {
            const { bucket, sourcePath, fileName } = parsePublicStorageUrl(sourceUrl);
            const destinationPath = `images/${user.id}/${journal.id}/${fileName}`.trim();
            const cleanSourcePath = sourcePath.trim();

            const isUsersTemp = cleanSourcePath.startsWith(`temp/${user.id}/`);
            const isAlreadyInImages = cleanSourcePath.startsWith(`images/${user.id}/`);
            if (!isUsersTemp && !isAlreadyInImages) {
              throw new Error('Object not found');
            }

            if (cleanSourcePath !== destinationPath) {
              const { error: moveError } = await supabaseClient.storage
                .from(bucket)
                .move(cleanSourcePath, destinationPath);
              if (moveError) {
                throw new Error(moveError.message);
              }
            }

            const { data: publicUrlData } = supabaseClient.storage.from(bucket).getPublicUrl(destinationPath);
            if (!publicUrlData?.publicUrl) {
              throw new Error('Failed to retrieve public URL after move');
            }

            return publicUrlData.publicUrl;
          };

          const settledResults = await processInBatches(imageUrls, moveImage);
          const movedImageUrls = settledResults
            .filter((item) => item.status === 'fulfilled')
            .map((item) => item.value);

          settledResults
            .filter((item) => item.status === 'rejected')
            .forEach((item) => {
              addError('images', item.reason?.message || 'Unknown image move error');
            });

          if (movedImageUrls.length > 0) {
            const imagesToInsert = movedImageUrls.map((url) => ({
              journal_id: journal.id,
              url,
            }));

            const { data: images, error: imagesError } = await supabaseClient
              .from('journal_image')
              .insert(imagesToInsert)
              .select('id, url, created_at');

            if (imagesError) {
              console.error('⚠️ Error saving images:', imagesError);
              addError('images', imagesError.message);
            } else {
              results.images = images || [];
              console.log(`✅ Saved ${images?.length || 0} images`);
            }
          }
        })(),
      );
    }

    // 3. Save audio files
    if (audioUrls.length > 0) {
      operations.push(
        (async () => {
          const audioToInsert = audioUrls.map((url) => ({
            journal_id: journal.id,
            url,
          }));

          const { data: audio, error: audioError } = await supabaseClient
            .from('journal_audio')
            .insert(audioToInsert)
            .select('id, url, created_at');

          if (audioError) {
            console.error('⚠️ Error saving audio files:', audioError);
            addError('audio', audioError.message);
          } else {
            results.audio = audio || [];
            console.log(`✅ Saved ${audio?.length || 0} audio files`);
          }
        })(),
      );
    }

    // 4. Process tags (find or create)
    if (tags.length > 0) {
      operations.push(
        (async () => {
          const cleanedTagNames = tags
            .filter((tag) => typeof tag === 'string')
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0);

          const uniqueTagMap = new Map();
          for (const tagName of cleanedTagNames) {
            const key = tagName.toLowerCase();
            if (!uniqueTagMap.has(key)) {
              uniqueTagMap.set(key, tagName);
            }
          }

          const uniqueTagNames = Array.from(uniqueTagMap.values());
          const tagIdsToLink = [];

          if (uniqueTagNames.length > 0) {
            const { data: existingTags, error: findTagsError } = await supabaseClient
              .from('tags')
              .select('id, name')
              .eq('user_id', user.id)
              .in('name', uniqueTagNames);

            if (findTagsError) {
              console.error('⚠️ Error fetching tags:', findTagsError);
              addError('tags', findTagsError.message);
            } else {
              const existingNames = new Map(
                (existingTags ?? []).map((tag) => [tag.name.toLowerCase(), tag]),
              );

              const missingNames = uniqueTagNames.filter(
                (name) => !existingNames.has(name.toLowerCase()),
              );

              existingNames.forEach((tag) => tagIdsToLink.push(tag.id));

              if (missingNames.length > 0) {
                const inserts = missingNames.map((name) => ({
                  name,
                  user_id: user.id,
                }));

                const { data: createdTags, error: createTagsError } = await supabaseClient
                  .from('tags')
                  .insert(inserts)
                  .select('id, name');

                if (createTagsError) {
                  console.error('⚠️ Error creating tags:', createTagsError);
                  addError('tags', createTagsError.message);
                } else if (createdTags) {
                  createdTags.forEach((tag) => tagIdsToLink.push(tag.id));
                }
              }
            }
          }

          if (tagIdsToLink.length > 0) {
            const tagsToInsert = tagIdsToLink.map((tagId) => ({
              journal_id: journal.id,
              tag_id: tagId,
            }));

            const { data: linkedTags, error: linkError } = await supabaseClient
              .from('journal_tag')
              .insert(tagsToInsert)
              .select('journal_id, tag_id');

            if (linkError) {
              console.error('⚠️ Error linking tags:', linkError);
              addError('tags', linkError.message);
            } else {
              results.tags = linkedTags || [];
              console.log(`✅ Linked ${linkedTags?.length || 0} tags to journal`);
            }
          }
        })(),
      );
    }

    // 5. Process location (find or create)
    if (location && location.city && location.state) {
      operations.push(
        (async () => {
          const { city, state } = location;
          const trimmedCity = city.trim();
          const trimmedState = state.trim();

          const { data: upsertedLocation, error: upsertLocationError } = await supabaseClient
            .from('locations')
            .upsert(
              {
                city: trimmedCity,
                state: trimmedState,
                user_id: user.id,
              },
              { onConflict: 'user_id,city,state' },
            )
            .select('id, city, state')
            .single();

          if (upsertLocationError) {
            console.error('⚠️ Error upserting location:', upsertLocationError);
            addError('location', upsertLocationError.message);
            return;
          }

          if (upsertedLocation) {
            const { data: linkedLocation, error: linkLocError } = await supabaseClient
              .from('journal_location')
              .insert({
                journal_id: journal.id,
                location_id: upsertedLocation.id,
              })
              .select('journal_id, location_id')
              .single();

            if (linkLocError) {
              console.error('⚠️ Error linking location:', linkLocError);
              addError('location', linkLocError.message);
            } else {
              results.location = linkedLocation;
              console.log(`✅ Location linked successfully`);
            }
          }
        })(),
      );
    }

    if (operations.length > 0) {
      await Promise.allSettled(operations);
    }

    console.log('🎉 Journal entry saved successfully!');

    // Вызываем функцию для расчета и выдачи наград (не блокируем основной ответ)
    const triggerReward = async () => {
      try {
        console.log('🎁 Triggering reward calculation...');
        const rewardResponse = await fetch(
          `${Deno.env.get('SUPABASE_URL')}/functions/v1/triger-reward`,
          {
            method: 'POST',
            headers: {
              Authorization: req.headers.get('Authorization') || '',
              'Content-Type': 'application/json',
              apikey: Deno.env.get('SUPABASE_ANON_KEY') || '',
            },
            body: JSON.stringify({ user_id: user.id }),
          },
        );

        if (rewardResponse.ok) {
          console.log('✅ Reward calculation triggered successfully');
        } else {
          console.warn('⚠️ Reward calculation failed, but journal saved');
        }
      } catch (rewardError) {
        console.warn('⚠️ Failed to trigger rewards:', rewardError.message);
      }
    };

    triggerReward();

    // Return result
    return new Response(
      JSON.stringify({
        success: true,
        data: results,
        message: 'Journal entry saved successfully',
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
        message: 'Failed to save journal entry',
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
