import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (body, init = {}) => new Response(JSON.stringify(body), {
  ...init,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    ...init.headers || {}
  }
});

const parseCsv = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const nullIfEmpty = (arr) => arr && arr.length ? arr : null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({}, { status: 204 });
  
  const url = new URL(req.url);
  let payload = {};
  
  if (req.method === "GET") {
    const q = url.searchParams;
    payload = {
      p_limit: Number(q.get("limit") ?? "20"),
      p_cursor_created_at: q.get("cursor_created_at"),
      p_cursor_id: q.get("cursor_id"),
      p_search: q.get("search"),
      p_tag_ids: nullIfEmpty(parseCsv(q.get("tag_ids"))) ?? null,
      p_location_ids: nullIfEmpty(parseCsv(q.get("location_ids"))) ?? null,
      p_date_from: q.get("date_from"),
      p_date_to: q.get("date_to"),
      p_favorite_only: q.get("favorite_only") && [
        "1",
        "true",
        "t",
        "yes"
      ].includes((q.get("favorite_only") || "").toLowerCase()) ? true : null
    };
  } else if (req.method === "POST") {
    try {
      const b = await req.json();
      payload = {
        p_limit: b.p_limit ?? 20,
        p_cursor_created_at: b.p_cursor_created_at ?? null,
        p_cursor_id: b.p_cursor_id ?? null,
        p_search: b.p_search ?? null,
        p_tag_ids: nullIfEmpty(b.p_tag_ids ?? null),
        p_location_ids: nullIfEmpty(b.p_location_ids ?? null),
        p_date_from: b.p_date_from ?? null,
        p_date_to: b.p_date_to ?? null,
        p_favorite_only: b.p_favorite_only === true ? true : null
      };
    } catch {
      return json({
        error: "Invalid JSON body"
      }, {
        status: 400
      });
    }
  } else {
    return json({
      error: "Method not allowed"
    }, {
      status: 405
    });
  }
  
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL"), 
    Deno.env.get("SUPABASE_ANON_KEY"), 
    {
      global: {
        headers: {
          Authorization: req.headers.get("Authorization") ?? ""
        }
      },
      auth: {
        persistSession: false,
        detectSessionInUrl: false
      }
    }
  );
  
  const { data, error } = await supabase.rpc("journal_public_page", payload);
  
  if (error) return json({
    error: error.message
  }, {
    status: 500
  });
  
  const rows = data ?? [];
  const items = rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    tags: r.tags ?? [],
    countMedia: r.count_media ?? 0,
    location: r.location ?? null,
    titleImage: r.title_image ?? null,
    createdAt: r.created_at,
    isFavorite: r.is_favorite
  }));
  
  const last = items.length ? items[items.length - 1] : null;
  const next_cursor = last ? {
    created_at: last.createdAt,
    id: last.id
  } : null;
  
  return json({
    items,
    next_cursor
  });
});



