import { createClient } from '@supabase/supabase-js';
import config from '../config.js';

// Invite and password reset links land with type=... (or an error) in the URL hash,
// which the client reads and clears when it starts, so note it first.
const authLinkParams = new URLSearchParams(window.location.hash.slice(1));
export const authLink = {
  type: authLinkParams.get('type'),
  error: authLinkParams.get('error_description'),
};

export const supabase = createClient(config.supabaseUrl, config.supabaseKey);
