/*
 * User management for the Configuration page. Creating and deleting auth users
 * needs the service role, so the browser calls this with the admin's session and
 * the function checks the caller is an admin before acting on their own org.
 *
 *   POST /admin-users/invite  { email, role, redirect_to }  → { user_id, invite_link }
 *   POST /admin-users/remove  { user_id }                   → { ok }
 *
 * Invites return a sign-up link for the admin to send, rather than emailing it,
 * so they work without a custom SMTP provider.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const ROLES = ['admin', 'customer'];

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

type Caller = { id: string; org_id: string };

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
}

async function must<T>(query: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}

async function authenticate(request: Request): Promise<Caller> {
  const token = request.headers.get('authorization')?.replace(/^Bearer /i, '');
  if (!token) throw new HttpError(401, 'Not signed in');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Not signed in');

  const profile = await must(admin.from('profiles').select('org_id, role').eq('id', data.user.id).maybeSingle());
  if (!profile || profile.role !== 'admin') throw new HttpError(403, 'Only admins can manage users');
  return { id: data.user.id, org_id: profile.org_id };
}

async function invite(caller: Caller, body: { email?: string; role?: string; redirect_to?: string }) {
  const email = (body.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
  if (!ROLES.includes(body.role ?? '')) throw new HttpError(400, 'Role must be admin or customer');
  let redirectTo: string | undefined;
  try {
    const url = new URL(body.redirect_to ?? '');
    if (url.protocol === 'http:' || url.protocol === 'https:') redirectTo = url.origin + url.pathname;
  } catch {
    redirectTo = undefined;
  }

  const { data, error } = await admin.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo } });
  if (error) {
    if (/already/i.test(error.message)) throw new HttpError(409, 'This email already has an account');
    throw new Error(error.message);
  }

  const { error: profileError } = await admin
    .from('profiles')
    .insert({ id: data.user.id, org_id: caller.org_id, email, role: body.role });
  if (profileError) {
    await admin.auth.admin.deleteUser(data.user.id);
    throw new Error(profileError.message);
  }
  return { user_id: data.user.id, invite_link: data.properties.action_link };
}

async function remove(caller: Caller, body: { user_id?: string }) {
  if (!body.user_id) throw new HttpError(400, 'user_id is required');
  if (body.user_id === caller.id) throw new HttpError(400, 'You cannot remove yourself');
  const profile = await must(admin.from('profiles').select('org_id').eq('id', body.user_id).maybeSingle());
  if (!profile || profile.org_id !== caller.org_id) throw new HttpError(404, 'No such user in your organisation');

  // Deleting the auth user removes the profile too (on delete cascade).
  const { error } = await admin.auth.admin.deleteUser(body.user_id);
  if (error) throw new Error(error.message);
  return { ok: true };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  try {
    if (request.method !== 'POST') throw new HttpError(405, 'Use POST');
    const caller = await authenticate(request);
    const route = new URL(request.url).pathname.replace(/^.*\/admin-users/, '');
    const body = await request.json().catch(() => ({}));

    if (route === '/invite') return json(await invite(caller, body));
    if (route === '/remove') return json(await remove(caller, body));
    throw new HttpError(404, 'Unknown route');
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    return json({ error: error instanceof Error ? error.message : String(error) }, status);
  }
});
