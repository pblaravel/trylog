import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * Supabase Edge Function: update-notification-state
 *
 * Обновление состояния уведомлений пользователя:
 * - timezone (IANA, напр. "America/New_York")
 * - last_app_open (ISO-строка или true для текущего момента)
 * - notifications_enabled (boolean)
 *
 * POST /functions/v1/update-notification-state
 * Authorization: Bearer <user access token>
 * Content-Type: application/json
 *
 * {
 *   "timezone": "Europe/Moscow",
 *   "last_app_open": true,
 *   "notifications_enabled": true
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
        const updates = { updated_at: new Date().toISOString() };

        if (typeof body.timezone === 'string' && body.timezone.trim().length > 0) {
            updates.timezone = body.timezone.trim();
        }

        if (body.last_app_open === true) {
            updates.last_app_open = new Date().toISOString();
        } else if (typeof body.last_app_open === 'string') {
            updates.last_app_open = body.last_app_open;
        }

        if (typeof body.notifications_enabled === 'boolean') {
            updates.notifications_enabled = body.notifications_enabled;
        }

        const { data, error } = await supabase
            .from('notification_state')
            .upsert(
                { user_id: user.id, ...updates },
                { onConflict: 'user_id' },
            )
            .select('user_id, timezone, last_app_open, notifications_enabled, updated_at')
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
