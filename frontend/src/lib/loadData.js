/*
 * Loads the signed-in user's data from Supabase and shapes it into the
 * dataset the derivations in model.js read.
 */
import { supabase } from './supabase.js';
import { addDays, byTime, datesBetween, firstOfPreviousMonth, localParts, mondayOf } from './dates.js';

const SEVERITIES = {
  Critical: { rank: 4 },
  High: { rank: 3 },
  Medium: { rank: 2 },
  Low: { rank: 1 },
};
const ONLINE_WINDOW_MS = 10 * 60 * 1000;
const PAGE_SIZE = 1000;

export function severityOf(points) {
  if (points >= 15) return 'Critical';
  if (points >= 8) return 'High';
  if (points >= 4) return 'Medium';
  return 'Low';
}

/* Queries ---------------------------------------------------------------- */

async function must(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function fetchIncidents(sinceIso, untilIso) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = await must(supabase
      .from('incidents')
      .select('id, started_at, zones(name, site_id), devices(serial), violations(violation_types(label, code, severity_points)), incident_clips(storage_path, duration_s, blurred)')
      .gte('started_at', sinceIso)
      .lt('started_at', untilIso)
      .order('started_at')
      .range(from, from + PAGE_SIZE - 1));
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

/* Shaping ---------------------------------------------------------------- */

function incidentRecord(row, timeZone) {
  const violations = row.violations
    .map((violation) => violation.violation_types)
    .sort((a, b) => b.severity_points - a.severity_points);
  if (!violations.length) return null;
  const local = localParts(new Date(row.started_at), timeZone);
  const clip = row.incident_clips[0];
  return {
    date: local.date,
    incident: {
      time: local.time,
      type: violations[0].label,
      severity: severityOf(violations[0].severity_points),
      // Score = max(0, 100 - total points of every violation in the window).
      points: violations.reduce((total, violation) => total + violation.severity_points, 0),
      zone: row.zones.name,
      camera: row.devices.serial,
      clip: clip ? { path: clip.storage_path, durationS: clip.duration_s, blurred: clip.blurred } : null,
    },
  };
}

function groupByDate(records) {
  const byDate = new Map();
  records.forEach((record) => {
    if (!byDate.has(record.date)) byDate.set(record.date, []);
    byDate.get(record.date).push(record.incident);
  });
  byDate.forEach((incidents, dateKey) => {
    incidents.sort(byTime);
    const compact = dateKey.replace(/-/g, '');
    incidents.forEach((incident, index) => {
      incident.id = 'EVT-' + compact + '-' + String(index + 1).padStart(4, '0');
    });
  });
  return byDate;
}

function scoreOf(incidents) {
  return Math.max(0, 100 - incidents.reduce((total, incident) => total + incident.points, 0));
}

function periodScores(byDate, today) {
  const windows = {
    today: [today],
    week: datesBetween(mondayOf(today), today),
    month: datesBetween(today.slice(0, 8) + '01', today),
  };
  const scores = {};
  Object.keys(windows).forEach((period) => {
    scores[period] = scoreOf(windows[period].flatMap((dateKey) => byDate.get(dateKey) || []));
  });
  return scores;
}

// asOf ('YYYY-MM-DD') shows the dashboard as it looked at the end of that day,
// for demos on recorded footage. Without it the dashboard shows the site's today.
export async function loadDashboardData(user, asOf = null) {
  const profile = await must(supabase.from('profiles').select('role, org_id').eq('id', user.id).maybeSingle());
  if (!profile) throw new Error('This account has no profile yet. Ask an admin to add you to an organisation.');

  const [organisation, sites, violationTypes] = await Promise.all([
    must(supabase.from('organisations').select('id, name').eq('id', profile.org_id).single()),
    must(supabase.from('sites').select('id, name, timezone, zones(id, name, devices(serial, last_heartbeat)), shifts(name, starts_at, ends_at)').order('name')),
    must(supabase.from('violation_types').select('label, code, severity_points')),
  ]);
  if (!sites.length) throw new Error('No sites are set up for this organisation yet.');

  const current = sites[0];
  const localNow = (timeZone) => (asOf ? { date: asOf, time: '23:59' } : localParts(new Date(), timeZone));
  const now = localNow(current.timezone);
  const firstDate = firstOfPreviousMonth(now.date);

  const [incidentRows, stats] = await Promise.all([
    fetchIncidents(addDays(firstDate, -1) + 'T00:00:00Z', addDays(now.date, 2) + 'T00:00:00Z'),
    must(supabase.from('site_daily_stats').select('day, people_observed').eq('site_id', current.id).gte('day', firstDate).lte('day', now.date)),
  ]);

  const bySite = new Map(sites.map((site) => [site.id, []]));
  incidentRows.forEach((row) => {
    const site = sites.find((candidate) => candidate.id === row.zones.site_id);
    const record = site && incidentRecord(row, site.timezone);
    if (record && record.date <= localNow(site.timezone).date) bySite.get(site.id).push(record);
  });

  const currentByDate = groupByDate(bySite.get(current.id));
  const peopleByDate = new Map(stats.map((row) => [row.day, row.people_observed]));
  const dailyRecords = datesBetween(firstDate, now.date).map((dateKey) => ({
    date: dateKey,
    peopleObserved: peopleByDate.get(dateKey) || 0,
    incidents: currentByDate.get(dateKey) || [],
  }));

  const devices = current.zones.flatMap((zone) => zone.devices);
  return {
    severities: SEVERITIES,
    violationTypes: violationTypes
      .map((type) => ({ name: type.label, severity: severityOf(type.severity_points), isPpe: type.code.startsWith('ppe_'), points: type.severity_points }))
      .sort((a, b) => b.points - a.points),
    shifts: current.shifts.map((shift) => ({ name: shift.name, start: shift.starts_at.slice(0, 5), end: shift.ends_at.slice(0, 5) })),
    zones: current.zones.map((zone) => ({ name: zone.name, cameras: zone.devices.map((device) => device.serial).sort() })),
    cameras: devices
      .map((device) => ({ id: device.serial, online: Boolean(device.last_heartbeat) && Date.now() - new Date(device.last_heartbeat) < ONLINE_WINDOW_MS }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    organisations: [{ id: organisation.id, name: organisation.name }],
    sites: sites.map((site) => ({
      id: site.id,
      name: site.name,
      scores: site.id === current.id ? null : periodScores(groupByDate(bySite.get(site.id)), localNow(site.timezone).date),
    })),
    currentSiteId: current.id,
    currentUser: { id: user.id, name: user.email, role: profile.role },
    scheduledReports: [],
    clock: { date: now.date, time: now.time, live: !asOf },
    dailyRecords,
  };
}
