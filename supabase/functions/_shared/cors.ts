// Shared CORS headers for backend functions. These are the headers
// `supabase.functions.invoke` sends from the browser; the webhook itself is
// called by Meta (server-to-server) but we keep this for consistency with
// every other function and in case a dashboard ever calls it directly.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
