import { useEffect, useRef, useState } from 'react';
import { formatDay } from '../lib/dates.js';
import { formatPoints } from '../lib/format.js';
import { supabase } from '../lib/supabase.js';
import { useDashboard } from './DashboardContext.js';
import { CloseIcon } from './icons.jsx';
import { Severity } from './ui.jsx';

const CLIP_BUCKET = 'incident-clips';
const CLIP_URL_TTL_S = 60 * 60;

// Clips are private: each one is fetched through a short-lived signed URL,
// which storage only issues to members of the incident's organisation.
function Clip({ clip, active }) {
  const [source, setSource] = useState({ path: null, url: null, failed: false });
  const videoRef = useRef(null);

  useEffect(() => {
    if (!clip || !active) return undefined;
    let cancelled = false;
    supabase.storage.from(CLIP_BUCKET).createSignedUrl(clip.path, CLIP_URL_TTL_S).then(({ data, error }) => {
      if (!cancelled) setSource({ path: clip.path, url: data?.signedUrl ?? null, failed: Boolean(error) });
    });
    return () => { cancelled = true; };
  }, [clip, active]);

  useEffect(() => {
    if (!active) videoRef.current?.pause();
  }, [active]);

  if (!clip) return <div className="clip"><span>No clip recorded for this incident</span></div>;
  if (source.path !== clip.path) return <div className="clip"><span>Loading clip…</span></div>;
  if (source.failed) return <div className="clip"><span>Clip unavailable</span></div>;
  return (
    <>
      <video className="clip-video" ref={videoRef} src={source.url} controls playsInline preload="metadata" />
      <p className="clip-caption mono">{(clip.blurred ? 'Blurred' : 'Not blurred') + ' · ' + Math.round(clip.durationS) + ' s'}</p>
    </>
  );
}

export default function Drawer({ onClose }) {
  const { derivations, selectedIncidentId } = useDashboard();
  const closeRef = useRef(null);
  // Keep showing the last incident while the drawer slides out.
  const lastIncidentRef = useRef(null);
  const isOpen = Boolean(selectedIncidentId);
  if (isOpen) lastIncidentRef.current = derivations.findIncident(selectedIncidentId);
  const incident = lastIncidentRef.current;

  useEffect(() => {
    if (isOpen) closeRef.current.focus();
  }, [isOpen, selectedIncidentId]);

  return (
    <aside className={'drawer' + (isOpen ? ' is-open' : '')} role="dialog" aria-modal="false" aria-labelledby="drawer-title" aria-hidden={!isOpen}>
      {incident && (
        <>
          <div className="drawer-header">
            <h2 className="drawer-title" id="drawer-title">{incident.id}</h2>
            <button type="button" className="icon-button" aria-label="Close" ref={closeRef} onClick={onClose}><CloseIcon /></button>
          </div>
          <div className="drawer-body">
            <Clip key={incident.id} clip={incident.clip} active={isOpen} />
            <dl className="details">
              <dt>Time</dt><dd><span className="mono">{formatDay(incident.date) + ' ' + incident.time}</span></dd>
              <dt>Violation</dt><dd>{incident.type}</dd>
              <dt>Severity</dt><dd><Severity severity={incident.severity} /></dd>
              <dt>Points deducted</dt><dd><span className="mono">{formatPoints(derivations.deductionOf(incident))}</span></dd>
              <dt>Zone</dt><dd>{incident.zone}</dd>
              <dt>Camera</dt><dd><span className="mono">{incident.camera}</span></dd>
              <dt>Shift</dt><dd>{incident.shift}</dd>
              <dt>Score after event</dt><dd><span className="mono">{incident.scoreAfter}</span></dd>
            </dl>
          </div>
        </>
      )}
    </aside>
  );
}
