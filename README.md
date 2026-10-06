# Sawtooth Trip Log

A phone-friendly app for sales trips. Log trips by state, each business you visit, the people you meet, and dated notes. Reminders become events on your Outlook calendar, and everything is saved to your own OneDrive so it's on every device you sign in to.

- **Trips** grouped by state, each with its stops
- **Stops**: address (or "use my location"), status, contacts, notes, Open in Maps
- **Map**: every stop as a dot, green for customers, yellow for potential customers (new lead, follow up, quoted), red for not interested. Filter by color or state; tap a dot to open the stop. Addresses are placed on the map automatically using OpenStreetMap
- **Reminders**: written to Outlook as calendar events with a 15-minute alert; moves, renames and deletes made in Outlook come back into the app
- **Storage**: `Apps/SawtoothTripLog/trip-log.json` in your OneDrive, cached on the device so it works with no signal and syncs when you're back online
- **Export**: CSV spreadsheet, full backup file, and import
- **Install**: works as a home-screen app on iPhone and Android

There is no server. The app is static files on GitHub Pages and talks straight to Microsoft Graph as the signed-in user.

## One-time Microsoft setup

Done once by a Microsoft 365 admin for the company. It takes about five minutes.

1. Go to <https://entra.microsoft.com> and sign in with your admin account.
2. In the left menu open **Applications → App registrations**, then click **New registration**.
3. Fill in:
   - **Name:** `Sawtooth Trip Log`
   - **Supported account types:** *Accounts in this organizational directory only (single tenant)*
   - **Redirect URI:** choose **Single-page application (SPA)** and enter the app's address, for example `https://scottydu3.github.io/Sawtooth-Trip-Log/` (with the trailing slash)
4. Click **Register**. On the page that opens, copy the **Application (client) ID** and the **Directory (tenant) ID**.
5. Open **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, tick **Calendars.ReadWrite** and **Files.ReadWrite**, and click **Add permissions**. (`User.Read` is already there.)
6. Click **Grant admin consent for (your company)** and confirm. All three permissions should show a green check.
7. Put the two IDs in `.env.production`:
   ```
   VITE_MS_CLIENT_ID=<Application (client) ID>
   VITE_MS_AUTHORITY=https://login.microsoftonline.com/<Directory (tenant) ID>
   ```
   These IDs are not secrets; every browser app ships them.

What the permissions allow, only for the person signed in: read their basic profile, add and change events on their own calendar, and read and write files in their own OneDrive (the app only touches its one file).

## Publishing

1. In the GitHub repo open **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Every push to `main` runs the tests, builds, and publishes to `https://<owner>.github.io/<repo>/`.

## Development

```
npm install
npm run dev      # http://localhost:5173, demo mode unless .env.local sets the IDs
npm test         # merge, OneDrive sync and Outlook sync against a fake Graph
npm run build
```

For local sign-in, add `http://localhost:5173/` as a second SPA redirect URI in the app registration and copy `.env.production` to `.env.local`.

## How sync works

- Every change is saved on the device first, then the whole data file is uploaded to OneDrive with the file's version (`If-Match`). If another device saved in between, the app downloads that copy, merges it record by record (newest edit wins, deletes are remembered), and uploads again.
- Each open reminder is mirrored as an Outlook event. The app checks those events whenever it's opened: a new time or title in Outlook updates the reminder, and an event deleted in Outlook is flagged with a **Re-add** button rather than recreated.
