/*
 * Admin settings: sites, zones, cameras, shifts, violation types and users.
 * Edits go straight to Supabase, where row level security limits them to admins
 * of the organisation; inviting and removing users goes through the admin-users
 * edge function because it needs the service role.
 */
import { useCallback, useEffect, useState } from 'react';
import { useDashboard } from '../components/DashboardContext.js';
import EditableTable from '../components/EditableTable.jsx';
import { Panel, Severity } from '../components/ui.jsx';
import { generateDeviceKey, sha256Hex } from '../lib/deviceKeys.js';
import { severityOf } from '../lib/loadData.js';
import { supabase } from '../lib/supabase.js';

const SERIAL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;
const ONLINE_WINDOW_MS = 10 * 60 * 1000;
// The codes the detection pipeline reports (pipeline/ppe_pipeline/ingest.py,
// VIOLATION_CODES). Other types can be added, but nothing reports them until
// the model and pipeline learn to detect them.
const DETECTED_CODES = new Set(['person_near_vehicle', 'ppe_no_vest']);
const ROLE_OPTIONS = [{ value: 'customer', label: 'Customer' }, { value: 'admin', label: 'Admin' }];

function friendlyError(error) {
  if (error.code === '23505') return 'That is already in use. Choose a different one.';
  return error.message;
}

async function must(query) {
  const { data, error } = await query;
  if (error) throw new Error(friendlyError(error));
  return data;
}

async function callAdminUsers(route, body) {
  const { data, error } = await supabase.functions.invoke('admin-users/' + route, { body });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error || error.message);
  }
  return data;
}

async function loadConfig() {
  const [sites, zones, devices, shifts, violationTypes, users] = await Promise.all([
    must(supabase.from('sites').select('id, name, timezone').order('name')),
    must(supabase.from('zones').select('id, site_id, name, zone_type').order('name')),
    must(supabase.from('devices').select('id, zone_id, serial, model, last_heartbeat').order('serial')),
    must(supabase.from('shifts').select('id, site_id, name, starts_at, ends_at').order('starts_at')),
    must(supabase.from('violation_types').select('id, code, label, severity_points').order('severity_points', { ascending: false })),
    must(supabase.from('profiles').select('id, email, role, created_at').order('email')),
  ]);
  const recorded = await Promise.all(violationTypes.map((type) => supabase
    .from('violations').select('id', { count: 'exact', head: true }).eq('violation_type_id', type.id)
    .then(({ count, error }) => { if (error) throw new Error(friendlyError(error)); return count; })));
  return {
    sites,
    zones,
    devices,
    shifts: shifts.map((shift) => ({ ...shift, starts_at: shift.starts_at.slice(0, 5), ends_at: shift.ends_at.slice(0, 5) })),
    violationTypes: violationTypes.map((type, index) => ({ ...type, recorded: recorded[index] })),
    users,
  };
}

function timeZoneOptions(current) {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return [...new Set([current, ...zones])].filter(Boolean).sort().map((zone) => ({ value: zone, label: zone }));
}

function shiftHours(shift) {
  const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const length = (minutes(shift.ends_at) - minutes(shift.starts_at) + 1440) % 1440 || 1440;
  return (length / 60).toFixed(length % 60 ? 1 : 0) + ' h';
}

function lastSeen(device, timeZone) {
  if (!device.last_heartbeat) return <span className="text-3">Never connected</span>;
  const seen = new Date(device.last_heartbeat);
  if (Date.now() - seen < ONLINE_WINDOW_MS) return 'Online';
  const when = seen.toLocaleString('en-GB', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return <span className="text-2">Offline, last seen {when}</span>;
}

function plural(count, word) {
  return count + ' ' + word + (count === 1 ? '' : 's');
}

// A value shown once (a device key or an invite link), with a copy button.
function SecretNotice({ secret, onDismiss }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="secret-notice" role="status">
      <strong>{secret.title}</strong>
      <span className="text-2">{secret.hint}</span>
      <code className="secret-value">{secret.value}</code>
      <div className="secret-actions">
        <button type="button" className="button" onClick={() => navigator.clipboard.writeText(secret.value).then(() => setCopied(true))}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="button" onClick={onDismiss}>Done</button>
      </div>
    </div>
  );
}

export default function ConfigurationPage() {
  const { data, reloadData } = useDashboard();
  const [config, setConfig] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [selectedSiteId, setSelectedSiteId] = useState(data.currentSiteId);
  const [adding, setAdding] = useState(null); // the panel whose add row is open
  const [secret, setSecret] = useState(null);
  const [rotatingId, setRotatingId] = useState(null);

  const refresh = useCallback(() => loadConfig().then(setConfig), []);
  useEffect(() => {
    refresh().catch(setLoadError);
  }, [refresh]);

  if (loadError) return <p className="app-message">Could not load configuration: {loadError.message}</p>;
  if (!config) return <p className="app-message">Loading…</p>;

  const orgId = data.organisations[0].id;
  const site = config.sites.find((candidate) => candidate.id === selectedSiteId) || config.sites[0];
  const siteZones = config.zones.filter((zone) => site && zone.site_id === site.id);
  const zoneName = new Map(config.zones.map((zone) => [zone.id, zone.name]));
  const siteDevices = config.devices.filter((device) => siteZones.some((zone) => zone.id === device.zone_id));
  const siteShifts = config.shifts.filter((shift) => site && shift.site_id === site.id);

  // Every change reloads this page's rows, then the dashboard's data behind it.
  async function changed() {
    await refresh();
    reloadData().catch(() => {});
  }

  function addingProps(panel) {
    return { adding: adding === panel, setAdding: (open) => setAdding(open ? panel : null) };
  }

  function addButton(panel, label, disabledReason) {
    return (
      <button
        type="button"
        className="button panel-action"
        disabled={Boolean(disabledReason) || adding === panel}
        title={disabledReason}
        onClick={() => { setAdding(panel); setSecret(null); }}
      >
        {label}
      </button>
    );
  }

  function showKey(serial, key) {
    setSecret({
      panel: 'cameras',
      title: 'Device key for ' + serial,
      hint: 'Copy it now: it is not stored and won’t be shown again. Put this line in pipeline/.env on the device.',
      value: 'DEVICE_KEY_' + serial + '=' + key,
    });
  }

  async function replaceKey(device) {
    const key = generateDeviceKey();
    await must(supabase.from('devices').update({ key_hash: await sha256Hex(key) }).eq('id', device.id));
    showKey(device.serial, key);
  }

  return (
    <div className="sheet">
      <Panel title="Sites" meta={plural(config.sites.length, 'site')} action={addButton('sites', 'Add site')}>
        <EditableTable
          {...addingProps('sites')}
          columns={[
            { key: 'name', label: 'Name', input: { required: true, placeholder: 'Warehouse 2' } },
            { key: 'timezone', label: 'Time zone', width: '220px', input: { type: 'select', required: true, options: timeZoneOptions(site?.timezone) } },
            { key: 'zones', label: 'Zones', width: '96px', numeric: true, display: (row) => config.zones.filter((zone) => zone.site_id === row.id).length },
          ]}
          rows={config.sites}
          newValues={{ name: '', timezone: 'Europe/London' }}
          canDelete={() => config.sites.length > 1}
          deleteWarning={(row) => 'Delete ' + row.name + '? Its zones, cameras, shifts and every incident recorded there are deleted too.'}
          onSave={async (values, row) => {
            const fields = { name: values.name.trim(), timezone: values.timezone };
            if (row) await must(supabase.from('sites').update(fields).eq('id', row.id));
            else await must(supabase.from('sites').insert({ ...fields, org_id: orgId }));
            await changed();
          }}
          onDelete={async (row) => {
            await must(supabase.from('sites').delete().eq('id', row.id));
            await changed();
          }}
        />
      </Panel>

      <section className="panel" aria-label="Site">
        <div className="filter-bar">
          <label className="filter">
            <span className="filter-label">Site</span>
            <select className="select" value={site?.id || ''} onChange={(event) => { setSelectedSiteId(event.target.value); setAdding(null); }}>
              {config.sites.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
          </label>
          <span className="filter-label">Zones, cameras and shifts below belong to this site.</span>
        </div>
      </section>

      <Panel title="Zones" meta={plural(siteZones.length, 'zone')} action={addButton('zones', 'Add zone')}>
        <EditableTable
          {...addingProps('zones')}
          columns={[
            { key: 'name', label: 'Name', input: { required: true, placeholder: 'Loading bay' } },
            { key: 'zone_type', label: 'Type', input: { placeholder: 'Optional' }, display: (row) => row.zone_type || <span className="text-3">None</span> },
            { key: 'cameras', label: 'Cameras', width: '96px', numeric: true, display: (row) => config.devices.filter((device) => device.zone_id === row.id).length },
          ]}
          rows={siteZones}
          newValues={{ name: '', zone_type: '' }}
          deleteWarning={(row) => {
            const cameras = config.devices.filter((device) => device.zone_id === row.id).length;
            return 'Delete ' + row.name + '? Its ' + plural(cameras, 'camera') + ' and all incidents recorded in it are deleted too.';
          }}
          onSave={async (values, row) => {
            const fields = { name: values.name.trim(), zone_type: values.zone_type?.trim() || null };
            if (row) await must(supabase.from('zones').update(fields).eq('id', row.id));
            else await must(supabase.from('zones').insert({ ...fields, site_id: site.id }));
            await changed();
          }}
          onDelete={async (row) => {
            await must(supabase.from('zones').delete().eq('id', row.id));
            await changed();
          }}
        />
      </Panel>

      <Panel
        title="Cameras"
        meta={plural(siteDevices.length, 'camera')}
        action={addButton('cameras', 'Add camera', siteZones.length ? null : 'Add a zone first')}
      >
        <EditableTable
          {...addingProps('cameras')}
          columns={[
            { key: 'serial', label: 'Serial', width: '160px', input: { required: true, onEdit: false, placeholder: 'FMDC1_01' }, display: (row) => <span className="mono">{row.serial}</span> },
            { key: 'zone_id', label: 'Zone', input: { type: 'select', required: true, options: siteZones.map((zone) => ({ value: zone.id, label: zone.name })) }, display: (row) => zoneName.get(row.zone_id) },
            { key: 'model', label: 'Model', input: { placeholder: 'Optional' }, display: (row) => row.model || <span className="text-3">None</span> },
            { key: 'status', label: 'Status', width: '220px', display: (row) => lastSeen(row, site.timezone) },
          ]}
          rows={siteDevices}
          actionsWidth="200px"
          newValues={{ serial: '', zone_id: siteZones[0]?.id, model: 'Jetson Orin Nano' }}
          deleteWarning={(row) => 'Delete ' + row.serial + '? Its incidents and recording sessions are deleted too, and the device can no longer report.'}
          rowActions={(row, { busy, run }) => (rotatingId === row.id ? (
            <>
              <button type="button" className="link link-button" disabled={busy} title="The device stops reporting until it has the new key"
                onClick={() => run(async () => { await replaceKey(row); setRotatingId(null); })}>
                Replace key
              </button>
              <button type="button" className="link link-button" onClick={() => setRotatingId(null)}>Keep</button>
            </>
          ) : (
            <button type="button" className="link link-button" disabled={busy} onClick={() => { setRotatingId(row.id); setSecret(null); }}>New key</button>
          ))}
          onSave={async (values, row) => {
            const fields = { zone_id: values.zone_id, model: values.model?.trim() || null };
            if (row) {
              await must(supabase.from('devices').update(fields).eq('id', row.id));
            } else {
              const serial = values.serial.trim();
              if (!SERIAL_PATTERN.test(serial)) throw new Error('Serials can only use letters, numbers, - and _, as the recorder names files with them.');
              if (config.devices.some((device) => device.serial === serial)) throw new Error('A camera with serial ' + serial + ' already exists.');
              const key = generateDeviceKey();
              await must(supabase.from('devices').insert({ ...fields, serial, key_hash: await sha256Hex(key) }));
              showKey(serial, key);
            }
            await changed();
          }}
          onDelete={async (row) => {
            await must(supabase.from('devices').delete().eq('id', row.id));
            await changed();
          }}
        />
        {secret?.panel === 'cameras' && <SecretNotice secret={secret} onDismiss={() => setSecret(null)} />}
      </Panel>

      <Panel title="Shifts" meta={plural(siteShifts.length, 'shift')} action={addButton('shifts', 'Add shift')}>
        <EditableTable
          {...addingProps('shifts')}
          columns={[
            { key: 'name', label: 'Name', input: { required: true, placeholder: 'Early' } },
            { key: 'starts_at', label: 'Starts', width: '120px', input: { type: 'time', required: true }, display: (row) => <span className="mono">{row.starts_at}</span> },
            { key: 'ends_at', label: 'Ends', width: '120px', input: { type: 'time', required: true }, display: (row) => <span className="mono">{row.ends_at}</span> },
            { key: 'length', label: 'Length', width: '96px', numeric: true, display: (row) => <span className="mono">{shiftHours(row)}</span> },
          ]}
          rows={siteShifts}
          newValues={{ name: '', starts_at: '06:00', ends_at: '14:00' }}
          deleteWarning={(row) => 'Delete ' + row.name + '? Past incidents stay, but are no longer assigned to a shift.'}
          onSave={async (values, row) => {
            const fields = { name: values.name.trim(), starts_at: values.starts_at, ends_at: values.ends_at };
            if (row) await must(supabase.from('shifts').update(fields).eq('id', row.id));
            else await must(supabase.from('shifts').insert({ ...fields, site_id: site.id }));
            await changed();
          }}
          onDelete={async (row) => {
            await must(supabase.from('shifts').delete().eq('id', row.id));
            await changed();
          }}
        />
        <p className="panel-note">Shifts that end before they start run overnight. Incidents are assigned to a shift when a device reports them.</p>
      </Panel>

      <Panel title="Violation types" meta={plural(config.violationTypes.length, 'type')} action={addButton('types', 'Add violation type')}>
        <EditableTable
          {...addingProps('types')}
          columns={[
            { key: 'label', label: 'Label', input: { required: true, placeholder: 'No hard hat' } },
            { key: 'code', label: 'Code', width: '200px', input: { required: true, onEdit: false, placeholder: 'ppe_no_hard_hat' }, display: (row) => <span className="mono">{row.code}</span> },
            { key: 'severity_points', label: 'Points', width: '96px', numeric: true, input: { type: 'number', required: true, min: 0 }, display: (row) => <span className="mono">{row.severity_points}</span> },
            { key: 'severity', label: 'Severity', width: '112px', display: (row) => <Severity severity={severityOf(row.severity_points)} /> },
            { key: 'ppe', label: 'PPE', width: '64px', display: (row) => (row.code.startsWith('ppe_') ? 'Yes' : <span className="text-3">No</span>) },
            { key: 'detected', label: 'Detected', width: '120px', display: (row) => (DETECTED_CODES.has(row.code) ? 'By cameras' : <span className="text-3">Not yet</span>) },
            { key: 'recorded', label: 'Recorded', width: '96px', numeric: true, display: (row) => <span className="mono">{row.recorded}</span> },
          ]}
          rows={config.violationTypes}
          newValues={{ label: '', code: 'ppe_', severity_points: 4 }}
          deleteWarning={(row) => [
            'Delete ' + row.label + '?',
            row.recorded ? 'This also deletes its ' + plural(row.recorded, 'recorded violation') + ', and any incident left with no other violation.' : '',
            DETECTED_CODES.has(row.code) ? 'Cameras still detect ' + row.code + ': those detections are dropped until a type with this code is added again.' : '',
          ].filter(Boolean).join(' ')}
          onSave={async (values, row) => {
            const points = Number(values.severity_points);
            if (!Number.isInteger(points) || points < 0) throw new Error('Points must be a whole number, 0 or more.');
            const fields = { label: values.label.trim(), severity_points: points };
            if (row) {
              await must(supabase.from('violation_types').update(fields).eq('id', row.id));
            } else {
              const code = values.code.trim();
              if (!CODE_PATTERN.test(code)) throw new Error('Codes use lower-case letters, numbers and _, starting with a letter.');
              await must(supabase.from('violation_types').insert({ ...fields, code, org_id: orgId }));
            }
            await changed();
          }}
          onDelete={async (row) => {
            await must(supabase.rpc('delete_violation_type', { p_type_id: row.id }));
            await changed();
          }}
        />
        <p className="panel-note">
          Devices report violations by code, so a code can’t change once created. A new type is only recorded once the model and
          pipeline are taught to detect it; until then it stays at zero. Codes starting with ppe_ count towards PPE compliance.
          Points set severity: 15 or more is Critical, 8 High, 4 Medium, below that Low.
        </p>
      </Panel>

      <Panel title="Users" meta={plural(config.users.length, 'user')} action={addButton('users', 'Invite user')}>
        <EditableTable
          {...addingProps('users')}
          columns={[
            {
              key: 'email', label: 'Email', input: { type: 'email', required: true, onEdit: false, placeholder: 'name@company.com' },
              display: (row) => (
                <div className="cell-flex">
                  <span className="truncate">{row.email}</span>
                  {row.id === data.currentUser.id && <span className="tag">You</span>}
                </div>
              ),
            },
            { key: 'role', label: 'Role', width: '140px', input: { type: 'select', required: true, options: ROLE_OPTIONS }, display: (row) => (row.role === 'admin' ? 'Admin' : 'Customer') },
            { key: 'created_at', label: 'Added', width: '120px', display: (row) => <span className="mono">{row.created_at.slice(0, 10)}</span> },
          ]}
          rows={config.users}
          newValues={{ email: '', role: 'customer' }}
          canEdit={(row) => row.id !== data.currentUser.id}
          canDelete={(row) => row.id !== data.currentUser.id}
          deleteWarning={(row) => 'Remove ' + row.email + '? Their account is deleted and they lose access.'}
          onSave={async (values, row) => {
            if (row) {
              await must(supabase.from('profiles').update({ role: values.role }).eq('id', row.id));
            } else {
              const email = values.email.trim();
              const result = await callAdminUsers('invite', { email, role: values.role, redirect_to: window.location.origin + window.location.pathname });
              setSecret({
                panel: 'users',
                title: 'Invite link for ' + email,
                hint: 'Send this link to them. It signs them in once so they can choose a password, and expires after an hour by default.',
                value: result.invite_link,
              });
            }
            await changed();
          }}
          onDelete={async (row) => {
            await callAdminUsers('remove', { user_id: row.id });
            await changed();
          }}
        />
        {secret?.panel === 'users' && <SecretNotice secret={secret} onDismiss={() => setSecret(null)} />}
        <p className="panel-note">Admins can change these settings. Customers can view the dashboard only.</p>
      </Panel>
    </div>
  );
}
