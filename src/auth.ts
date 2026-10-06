import { PublicClientApplication, InteractionRequiredAuthError, type AccountInfo } from "@azure/msal-browser";

export const SCOPES = ["User.Read", "Calendars.ReadWrite", "Files.ReadWrite"];

const clientId = import.meta.env.VITE_MS_CLIENT_ID as string | undefined;
// "common" accepts both work/school and personal Microsoft accounts.
const authority = (import.meta.env.VITE_MS_AUTHORITY as string | undefined) || "https://login.microsoftonline.com/common";

/** True when the build has an Azure app registration; otherwise the app runs in on-device demo mode. */
export const authConfigured = !!clientId;

// Who last signed in (an email address, not a credential), so the app can renew the
// sign-in through Microsoft's own session instead of asking again after a restart.
const HINT_KEY = "tripLog.loginHint";
// Set for one browser session while a no-prompt renewal is in flight, to avoid redirect loops.
const TRIED_KEY = "tripLog.silentTried";

let pca: PublicClientApplication | null = null;
let account: AccountInfo | null = null;

const store = {
  get: (s: Storage, k: string) => { try { return s.getItem(k); } catch { return null; } },
  set: (s: Storage, k: string, v: string) => { try { s.setItem(k, v); } catch { /* blocked */ } },
  del: (s: Storage, k: string) => { try { s.removeItem(k); } catch { /* blocked */ } },
};

export function redirectUri(): string {
  return new URL(import.meta.env.BASE_URL, location.origin).href;
}

/** Thrown by getToken when Microsoft needs the user to confirm sign-in again. */
export class ReconnectNeeded extends Error {
  constructor() { super("Reconnect to Microsoft to keep syncing."); }
}

export async function initAuth(): Promise<AccountInfo | null> {
  if (!clientId) return null;
  pca = new PublicClientApplication({
    auth: { clientId, authority, redirectUri: redirectUri() },
    cache: { cacheLocation: "localStorage" },
  });
  await pca.initialize();
  let res = null;
  try { res = await pca.handleRedirectPromise(); }
  catch { /* a no-prompt renewal that Microsoft refused: fall through to the sign-in button */ }
  account = res?.account ?? pca.getAllAccounts()[0] ?? null;
  if (!account) account = await renewFromMicrosoftSession();
  if (account) {
    pca.setActiveAccount(account);
    store.set(localStorage, HINT_KEY, account.username);
    store.del(sessionStorage, TRIED_KEY);
  }
  return account;
}

/**
 * The app's own token cache doesn't survive the app being closed, but Microsoft's sign-in
 * session does (when "Stay signed in" was chosen). Ask Microsoft for a fresh sign-in
 * without showing any prompt; this returns to the app on its own.
 */
async function renewFromMicrosoftSession(): Promise<AccountInfo | null> {
  const hint = store.get(localStorage, HINT_KEY);
  if (!pca || !hint || !navigator.onLine) return null;
  try {
    const r = await pca.ssoSilent({ scopes: SCOPES, loginHint: hint });
    return r.account;
  } catch { /* browsers that block Microsoft's cookie in a hidden frame: use a full-page pass instead */ }
  if (store.get(sessionStorage, TRIED_KEY)) return null;
  store.set(sessionStorage, TRIED_KEY, "1");
  await pca.loginRedirect({ scopes: SCOPES, loginHint: hint, prompt: "none" });
  return new Promise(() => { /* page is navigating away */ });
}

export function currentAccount(): AccountInfo | null {
  return account;
}

export async function signIn(): Promise<void> {
  if (!pca) throw new Error("Sign-in isn't set up for this build.");
  const hint = store.get(localStorage, HINT_KEY);
  await pca.loginRedirect({ scopes: SCOPES, ...(hint ? { loginHint: hint } : { prompt: "select_account" }) });
}

export async function signOut(): Promise<void> {
  if (!pca) return;
  store.del(localStorage, HINT_KEY);
  await pca.logoutRedirect({ account: account ?? undefined, postLogoutRedirectUri: redirectUri() });
}

export async function getToken(): Promise<string> {
  if (!pca || !account) throw new Error("Not signed in");
  try {
    const r = await pca.acquireTokenSilent({ scopes: SCOPES, account });
    return r.accessToken;
  } catch (e) {
    // Don't jump to Microsoft's page mid-task; the app offers a Reconnect button instead.
    if (e instanceof InteractionRequiredAuthError) throw new ReconnectNeeded();
    throw e;
  }
}

/** Renew sign-in through Microsoft's page. With an active Microsoft session this passes straight through. */
export async function reconnect(): Promise<void> {
  if (!pca || !account) return;
  await pca.acquireTokenRedirect({ scopes: SCOPES, account, loginHint: account.username });
}
