import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * Supabase Edge Function: update-notification-state
 *
 * Обновление состояния уведомлений пользователя в profiles_notifications.
 * Вызывается iOS-клиентом при открытии приложения и смене настроек.
 *
 * POST /functions/v1/update-notification-state
 * Authorization: Bearer <user access token>
 * Content-Type: application/json
 *
 * {
 *   "timezone": "America/New_York",      // IANA timezone
 *   "last_app_open": true,               // true = сейчас, или ISO-строка
 *   "fcm_token": "firebase-token-here"   // опционально, обновить FCM токен
 * }
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
        const updates = {};

        if (typeof body.timezone === 'string' && body.timezone.trim().length > 0) {
            updates.timezone = body.timezone.trim();
        }

        if (body.last_app_open === true) {
            updates.last_app_open = new Date().toISOString();
        } else if (typeof body.last_app_open === 'string') {
            updates.last_app_open = body.last_app_open;
        }

        if (typeof body.fcm_token === 'string') {
            updates.fcm_token = body.fcm_token.trim() || null;
        }

        if (Object.keys(updates).length === 0) {
            return json({ success: false, error: 'No fields to update' }, 400);
        }

        const { data, error } = await supabase
            .from('profiles_notifications')
            .upsert(
                { id: user.id, ...updates },
                { onConflict: 'id' },
            )
            .select('id, fcm_token, timezone, last_app_open')
            .single();

        if (error) {
            console.error('Error updating notification state:', error);
            return json({ success: false, error: 'Failed to update state' }, 500);
        }

        return json({ success: true, data });

    } catch (error) {
        console.error('Error:', error);
        return json({ success: false, error: error.message || 'Unknown error' }, 500);
    }
});
