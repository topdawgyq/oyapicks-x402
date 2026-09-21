// src/lib/supabase-admin.ts
// Server-only Supabase client using the service role key. Self-contained so it
// does not depend on the existing lib/supabase.ts wiring. NEVER import this in a
// client component.

import { createClient } from '@supabase/supabase-js'

export function supabaseAdmin() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  return createClient(url, key, { auth: { persistSession: false } })
}
