/*
 * Device ingest endpoint. Edge devices (the Jetson, or the replay script) call it
 * with their own key rather than a user session, so JWT verification is off and
 * every request is checked against devices.key_hash instead.
 *
 *   POST /ingest/session    report a session's incidents and people observed
 *   POST /ingest/clip       get a signed upload URL for an incident's clip
 *   POST /ingest/heartbeat  mark the device as online
 *
 * Headers: x-device-serial, x-device-key.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const CLIP_BUCKET = 'incident-clips';

type Device = { id: string; serial: string; zone_id: string; site_id: string; org_id: string; timezone: string };

type ViolationInput = {
  code: string;
  first_seen_at: string;
  last_seen_at: string;
  confidence?: number | null;
  vote_ratio?: number | null;
};

type IncidentInput = { track_id: number; violations: ViolationInput[] };

type SessionInput = {
  session_id: string;
  recording?: string | null;
  started_at: string;
  ended_at?: string | null;
  people_observed?: number;
  incidents?: IncidentInput[];
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function must<T>(query: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

async function authenticate(request: Request): Promise<Device> {
  const serial = request.headers.get('x-device-serial');
  const key = request.headers.get('x-device-key');
  if (!serial || !key) throw new HttpError(401, 'Missing device credentials');

  const row = await must(supabase
    .from('devices')
    .select('id, serial, zone_id, key_hash, zones(site_id, sites(org_id, timezone))')
    .eq('serial', serial)
    .maybeSingle());
  if (!row || !timingSafeEqual(await sha256Hex(key), row.key_hash)) throw new HttpError(401, 'Unknown device or wrong key');

  // deno-lint-ignore no-explicit-any
  const zone = row.zones as any;
  return { id: row.id, serial: row.serial, zone_id: row.zone_id, site_id: zone.site_id, org_id: zone.sites.org_id, timezone: zone.sites.timezone };
}

function localParts(instant: Date, timeZone: string) {
  const parts: Record<string, string> = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).forEach((part) => { parts[part.type] = part.value; });
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function shiftContains(shift: { starts_at: string; ends_at: string }, time: string) {
  const start = shift.starts_at.slice(0, 5);
  const end = shift.ends_at.slice(0, 5);
  return start < end ? time >= start && time < end : time >= start || time < end;
}

function minIso(values: string[]) {
  return values.reduce((a, b) => (new Date(a) <= new Date(b) ? a : b));
}

function maxIso(values: string[]) {
  return values.reduce((a, b) => (new Date(a) >= new Date(b) ? a : b));
}

async function heartbeat(device: Device) {
  await must(supabase.from('devices').update({ last_heartbeat: new Date().toISOString() }).eq('id', device.id));
}

async function reportSession(device: Device, body: SessionInput) {
  if (!body.session_id || !body.started_at) throw new HttpError(400, 'session_id and started_at are required');

  // Codes with no violation type (never added, or deleted by an admin) are
  // skipped rather than failing the whole session, and reported back.
  const types = await must(supabase.from('violation_types').select('id, code').eq('org_id', device.org_id));
  const typeIdByCode = new Map(types.map((type) => [type.code, type.id]));
  const reported = body.incidents ?? [];
  const skippedCodes = [...new Set(reported.flatMap((incident) => incident.violations.map((v) => v.code)))]
    .filter((code) => !typeIdByCode.has(code));
  const incidents = reported.map((incident) => ({
    ...incident,
    violations: incident.violations.filter((v) => typeIdByCode.has(v.code)),
  }));
  if (skippedCodes.length) console.warn(`Device ${device.serial} reported unknown codes: ${skippedCodes.join(', ')}`);

  const existing = await must(supabase.from('device_sessions').select('device_id').eq('id', body.session_id).maybeSingle());
  if (existing && existing.device_id !== device.id) throw new HttpError(409, 'Session belongs to another device');

  await must(supabase.from('device_sessions').upsert({
    id: body.session_id,
    device_id: device.id,
    recording: body.recording ?? null,
    started_at: body.started_at,
    ended_at: body.ended_at ?? null,
    people_observed: Math.max(0, Math.round(body.people_observed ?? 0)),
  }));

  const shifts = await must(supabase.from('shifts').select('id, starts_at, ends_at').eq('site_id', device.site_id));
  const incidentRows = incidents
    .filter((incident) => incident.violations.length)
    .map((incident) => {
      const startedAt = minIso(incident.violations.map((v) => v.first_seen_at));
      const local = localParts(new Date(startedAt), device.timezone);
      const shift = shifts.find((candidate) => shiftContains(candidate, local.time));
      return {
        zone_id: device.zone_id,
        device_id: device.id,
        shift_id: shift ? shift.id : null,
        session_id: body.session_id,
        track_id: incident.track_id,
        started_at: startedAt,
        ended_at: maxIso(incident.violations.map((v) => v.last_seen_at)),
        status: 'closed',
      };
    });

  let saved: { id: string; track_id: number }[] = [];
  if (incidentRows.length) {
    saved = await must(supabase
      .from('incidents')
      .upsert(incidentRows, { onConflict: 'device_id,session_id,track_id' })
      .select('id, track_id'));

    const incidentIdByTrack = new Map(saved.map((row) => [row.track_id, row.id]));
    const violationRows = incidents.flatMap((incident) => incident.violations.map((v) => ({
      incident_id: incidentIdByTrack.get(incident.track_id),
      violation_type_id: typeIdByCode.get(v.code),
      first_seen_at: v.first_seen_at,
      last_seen_at: v.last_seen_at,
      confidence: v.confidence ?? null,
      vote_ratio: v.vote_ratio ?? null,
    })));
    await must(supabase.from('violations').upsert(violationRows, { onConflict: 'incident_id,violation_type_id' }));
  }

  const day = localParts(new Date(body.started_at), device.timezone).date;
  await must(supabase.rpc('refresh_site_daily_stats', { p_site_id: device.site_id, p_day: day }));
  await heartbeat(device);

  return { session_id: body.session_id, incidents: saved, skipped_codes: skippedCodes };
}

async function requestClipUpload(device: Device, body: { incident_id: string; duration_s?: number; blurred?: boolean }) {
  const incident = await must(supabase.from('incidents').select('id, device_id').eq('id', body.incident_id).maybeSingle());
  if (!incident || incident.device_id !== device.id) throw new HttpError(404, 'Incident not found for this device');

  const path = `${device.serial}/${incident.id}.mp4`;
  const { data, error } = await supabase.storage.from(CLIP_BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (error) throw new Error(error.message);

  await must(supabase.from('incident_clips').upsert({
    incident_id: incident.id,
    storage_path: path,
    duration_s: body.duration_s == null ? null : Math.round(body.duration_s),
    blurred: Boolean(body.blurred),
  }, { onConflict: 'storage_path' }));

  return { path, signed_url: data.signedUrl };
}

Deno.serve(async (request) => {
  try {
    if (request.method !== 'POST') throw new HttpError(405, 'Use POST');
    const device = await authenticate(request);
    const route = new URL(request.url).pathname.replace(/^.*\/ingest/, '');
    const body = await request.json().catch(() => ({}));

    if (route === '/session') return json(await reportSession(device, body));
    if (route === '/clip') return json(await requestClipUpload(device, body));
    if (route === '/heartbeat') {
      await heartbeat(device);
      return json({ ok: true });
    }
    throw new HttpError(404, 'Unknown route');
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    return json({ error: error instanceof Error ? error.message : String(error) }, status);
  }
});
