export function CaretIcon() {
  return <svg className="icon icon-small" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" /></svg>;
}

export function CheckIcon() {
  return <svg className="icon icon-small" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.5 5 9l4.5-6" /></svg>;
}

export function PlayIcon() {
  return <svg className="icon icon-small icon-fill" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 2v8l6.5-4Z" /></svg>;
}

export function CloseIcon() {
  return <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>;
}

export function LockIcon() {
  return <svg className="icon icon-small nav-lock" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="5.5" width="7" height="5" /><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" /></svg>;
}

export const NAV_ICONS = {
  overview: <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" /><rect x="9" y="2.5" width="4.5" height="4.5" /><rect x="2.5" y="9" width="4.5" height="4.5" /><rect x="9" y="9" width="4.5" height="4.5" /></svg>,
  incidents: <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5 14 13.5H2Z" /><path d="M8 6.5v3.5" /><path d="M8 11.5v.5" /></svg>,
  shifts: <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></svg>,
  zones: <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" /><path d="M7.5 2.5v11" /><path d="M7.5 8.5h6" /></svg>,
  reports: <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h6l3 3v10h-9Z" /><path d="M6 8h4.5" /><path d="M6 10.5h4.5" /></svg>,
  configuration: <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11" /><path d="M2.5 11.5h11" /><rect x="5" y="3" width="2.5" height="3" /><rect x="9" y="10" width="2.5" height="3" /></svg>,
};
