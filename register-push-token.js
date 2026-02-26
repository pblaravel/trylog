import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * Supabase Edge Function: register-push-token
 *
 * Регистрация, обновление и удаление push-токена устройства.
 *
 * POST /functions/v1/register-push-token
 * Authorization: Bearer <user access token>
 * Content-Type: application/json
 *
 * Регистрация / обновление:
 * { "token": "ExponentPushToken[xxx]", "platform": "ios" }
 *
 * Удаление:
 * { "token": "ExponentPushToken[xxx]", "action": "unregister" }
 */

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (req.method !== 'POST') {
        return json({ success: false, error: 'Method not allowed' }, 405);
    }

    try {
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            return json({ success: false, error: 'Missing authorization token' }, 401);
        }

        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_ANON_KEY') ?? '',
            { global: { headers: { Authorization: authHeader } } },
        );

        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
            return json({ success: false, error: 'User not authenticated' }, 401);
        }

        const body = await req.json();
        const { token, platform = 'ios', action } = body;

        if (!token || typeof token !== 'string' || token.trim().length === 0) {
            return json({ success: false, error: 'Push token is required' }, 400);
        }

        const trimmedToken = token.trim();

        if (action === 'unregister') {
            const { error: deleteError } = await supabase
                .from('push_tokens')
                .delete()
                .eq('user_id', user.id)
                .eq('token', trimmedToken);

            if (deleteError) {
                console.error('Error deleting push token:', deleteError);
                return json({ success: false, error: 'Failed to remove token' }, 500);
            }

            console.log(`Push token removed for user ${user.id}`);
            return json({ success: true, message: 'Token removed' });
        }

        const validPlatform = ['ios', 'android'].includes(platform) ? platform : 'ios';

        const { data: existing } = await supabase
            .from('push_tokens')
            .select('id')
            .eq('user_id', user.id)
            .eq('token', trimmedToken)
            .maybeSingle();

        if (existing) {
            const { error: updateError } = await supabase
                .from('push_tokens')
                .update({ platform: validPlatform, updated_at: new Date().toISOString() })
                .eq('id', existing.id);

            if (updateError) {
                console.error('Error updating push token:', updateError);
                return json({ success: false, error: 'Failed to update token' }, 500);
            }

            console.log(`Push token updated for user ${user.id}`);
            return json({ success: true, message: 'Token updated' });
        }

        const { error: insertError } = await supabase
            .from('push_tokens')
            .insert({
                user_id: user.id,
                token: trimmedToken,
                platform: validPlatform,
            });

        if (insertError) {
            console.error('Error inserting push token:', insertError);
            return json({ success: false, error: 'Failed to register token' }, 500);
        }

        // Создаём notification_state если ещё нет
        await supabase
            .from('notification_state')
            .upsert(
                { user_id: user.id, notifications_enabled: true },
                { onConflict: 'user_id' },
            );

        console.log(`Push token registered for user ${user.id}`);
        return json({ success: true, message: 'Token registered' });

    } catch (error) {
        console.error('Error:', error);
        return json({ success: false, error: error.message || 'Unknown error' }, 500);
    }
});
