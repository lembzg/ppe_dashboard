import { useEffect, useState } from 'react';
import Dashboard from './Dashboard.jsx';
import { loadDashboardData } from './lib/loadData.js';
import { authLink, supabase } from './lib/supabase.js';

// ?asOf=YYYY-MM-DD shows the dashboard as of the end of that day.
const AS_OF = (() => {
  const value = new URLSearchParams(window.location.search).get('asOf');
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : null;
})();
const LIVE_REFRESH_MS = 60 * 1000;

function SignIn() {
  const [note, setNote] = useState(authLink.error || '');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    const form = new FormData(event.target);
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: form.get('email'), password: form.get('password') });
    setBusy(false);
    if (error) setNote(error.message);
  }

  return (
    <form className="sign-in" onSubmit={onSubmit}>
      <strong className="sign-in-title">NODE</strong>
      <input className="sign-in-input" name="email" type="email" placeholder="Email" required autoComplete="username" />
      <input className="sign-in-input" name="password" type="password" placeholder="Password" required autoComplete="current-password" />
      <button className="button" type="submit" disabled={busy}>Sign in</button>
      <span className="sign-in-note" role="alert">{note}</span>
    </form>
  );
}

// Shown after following an invite or password reset link, which signs the person in once.
function SetPassword({ onDone }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    const form = new FormData(event.target);
    if (form.get('password') !== form.get('confirm')) {
      setNote('The passwords don\u2019t match.');
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: form.get('password') });
    setBusy(false);
    if (error) setNote(error.message);
    else onDone();
  }

  return (
    <form className="sign-in" onSubmit={onSubmit}>
      <strong className="sign-in-title">Choose a password</strong>
      <input className="sign-in-input" name="password" type="password" placeholder="New password" required minLength={8} autoComplete="new-password" />
      <input className="sign-in-input" name="confirm" type="password" placeholder="Repeat password" required minLength={8} autoComplete="new-password" />
      <button className="button" type="submit" disabled={busy}>Save password</button>
      <span className="sign-in-note" role="alert">{note}</span>
    </form>
  );
}

// Shows the sign-in form without a session, otherwise loads the user's data and shows the dashboard.
export default function App() {
  const [user, setUser] = useState(undefined); // undefined until the session is known
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [needsPassword, setNeedsPassword] = useState(authLink.type === 'invite' || authLink.type === 'recovery');

  useEffect(() => {
    // Only record the user here: awaiting other Supabase calls inside this callback can deadlock.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session ? session.user : null);
    });
    return () => subscription.unsubscribe();
  }, []);

  const userId = user ? user.id : null;
  useEffect(() => {
    setData(null);
    setError(null);
    if (!userId) return undefined;
    let cancelled = false;
    loadDashboardData(user, AS_OF)
      .then((loaded) => { if (!cancelled) setData(loaded); })
      .catch((loadError) => { if (!cancelled) setError(loadError); });
    // Without asOf, reload every minute so the clock, today's figures and the charts stay current.
    const timer = AS_OF ? null : setInterval(() => {
      loadDashboardData(user, null).then((loaded) => { if (!cancelled) setData(loaded); }).catch(() => {});
    }, LIVE_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
    // Reload only when the signed-in user changes, not on token refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Reloads in the background after the Configuration page changes something.
  const reloadData = () => loadDashboardData(user, AS_OF).then(setData);

  if (user === undefined) return null;
  if (!user) return <SignIn />;
  if (needsPassword) return <SetPassword onDone={() => setNeedsPassword(false)} />;
  if (error) return <p className="app-message">Could not load data: {error.message}</p>;
  if (!data) return <p className="app-message">Loading…</p>;
  return <Dashboard data={data} reloadData={reloadData} />;
}
