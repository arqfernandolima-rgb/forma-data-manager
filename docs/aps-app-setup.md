# APS app setup (about 5 minutes, once)

The Data Connector API only accepts a **user sign-in** (OAuth 3-legged) made through an Autodesk Platform Services (APS) app. Each organization uses **its own** APS app; this project doesn't ship one. That keeps you in control: your admins decide which apps can reach your hub, and nothing depends on a third party's app.

## 1. Create the APS app

1. Go to **[aps.autodesk.com](https://aps.autodesk.com) → Applications** and sign in.
2. **Create application.**
3. Application type: **Desktop, Mobile, Single-Page App**. This type uses PKCE, so there is no client secret to store or leak.
4. **Callback URL:** `http://localhost:8642/callback`
   - Forma Data Manager shows the exact URL in the setup wizard and in Settings, with a copy button.
   - If port 8642 is taken on your PC, pick another port in the app (Settings → Callback port) and update the callback URL here to match.
5. **API access:** enable the **Autodesk Construction Cloud API** and the **Data Management API**. Portal wording changes from time to time; these are the APIs behind Data Connector and the hub list.
6. Save and copy the **Client ID**.

## 2. Allow the app in your hub

A hub admin adds the Client ID to the hub:

1. In Autodesk Forma, open **Hub Admin** (formerly Account Admin) → **Settings** → **Custom Integrations**.
2. **Add custom integration**, paste the **Client ID**, and give it a name like "Forma Data Manager". If the dialog asks which access to grant, keep both **Account Administration** and **Document Management** checked and choose **I'm the developer**. (Newer hubs only ask for the Client ID and a name.)

Without this step, signing in works but Data Connector calls fail with **403**.

## 3. Who can sign in

To extract the whole hub, the Data Connector API requires the signed-in user to have **Executive Overview** access. A hub (account) admin grants it in Hub Admin; being a hub admin doesn't include it automatically. Project admins can only extract their own projects, which this app doesn't do.

## 4. Scopes requested

| Scope | Why |
|---|---|
| `data:read` | List hubs; read Data Connector requests, jobs and files |
| `data:write`, `data:create` | Create Data Connector requests (one per sync, plus the daily schedule the app maintains); turn that schedule back on or extend it; delete the requests this app created |
| `user-profile:read` | Show "Signed in as …" in the app |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser shows an error about the redirect URI | The callback URL in your APS app must match the app exactly, including the port and `/callback` |
| "Port 8642 is already in use" | Pick another port in Settings and update the APS callback URL |
| Hub list is empty | The Client ID isn't added under Custom Integrations in that hub, or the account has no ACC/BIM 360 hubs. You can also enter the hub ID by hand |
| 403 from Data Connector | Check the Custom Integration, and that the signed-in user has **Executive Overview** access |
| "Your Autodesk sign-in expired" | Refresh tokens expire after about 15 days without use. Sign in again. The app refreshes automatically while it runs |
