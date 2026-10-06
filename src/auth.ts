import { PublicClientApplication, InteractionRequiredAuthError, type AccountInfo } from "@azure/msal-browser";

export const SCOPES = ["User.Read", "Calendars.ReadWrite", "Files.ReadWrite"];

const clientId = import.meta.env.VITE_MS_CLIENT_ID as string | undefined;
// "common" accepts both work/school and personal Microsoft accounts.
const authority = (import.meta.env.VITE_MS_AUTHORITY as string | undefined) || "https://login.microsoftonline.com/common";

/** True when the build has an Azure app registration; otherwise the app runs in on-device demo mode. */
export const authConfigured = !!clientId;

let pca: PublicClientApplication | null = null;
let account: AccountInfo | null = null;

export function redirectUri(): string {
  return new URL(import.meta.env.BASE_URL, location.origin).href;
}

export async function initAuth(): Promise<AccountInfo | null> {
  if (!clientId) return null;
  pca = new PublicClientApplication({
    auth: { clientId, authority, redirectUri: redirectUri() },
    cache: { cacheLocation: "localStorage" },
  });
  await pca.initialize();
  const res = await pca.handleRedirectPromise();
  account = res?.account ?? pca.getAllAccounts()[0] ?? null;
  if (account) pca.setActiveAccount(account);
  return account;
}

export function currentAccount(): AccountInfo | null {
  return account;
}

export async function signIn(): Promise<void> {
  if (!pca) throw new Error("Sign-in isn't set up for this build.");
  await pca.loginRedirect({ scopes: SCOPES, prompt: "select_account" });
}

export async function signOut(): Promise<void> {
  if (!pca) return;
  await pca.logoutRedirect({ account: account ?? undefined, postLogoutRedirectUri: redirectUri() });
}

export async function getToken(): Promise<string> {
  if (!pca || !account) throw new Error("Not signed in");
  try {
    const r = await pca.acquireTokenSilent({ scopes: SCOPES, account });
    return r.accessToken;
  } catch (e) {
    if (e instanceof InteractionRequiredAuthError) {
      await pca.acquireTokenRedirect({ scopes: SCOPES, account });
    }
    throw e;
  }
}
