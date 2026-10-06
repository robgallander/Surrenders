# Monthly Surrenders website (Azure Static Web Apps, fed by a HubSpot workflow)

Built the same way as the Altman Pod trial tracker site: a HubSpot workflow sends each surrender deal to the site whenever it changes, the site stores it in Azure Storage, and only members of one Microsoft group can sign in. **No HubSpot private app or key is used.**

## What's in this folder

| File | What it does |
|---|---|
| `index.html` | The report page |
| `no-access.html` | Shown to people who sign in but aren't in the allowed group |
| `api/src/functions/surrenders.js` | Receives deals from HubSpot (`/api/ingest`), stores them, and serves the report data |
| `api/coordinators.json` | Coordinator ID → name list. Add a line if the site ever shows "Coordinator #123" |
| `staticwebapp.config.json` | Microsoft sign-in, limited to your group |

## Setup

### 1. Put the files on GitHub
Create a new **private** repository (for example `surrenders-site`) and upload everything inside this folder, including `api`.

### 2. Sign-in (Microsoft 365 / Entra admin)
You can reuse the Altman Pod site's app registration or create a new one.
1. In **Microsoft Entra ID → App registrations**, open or create the registration ("Accounts in this organizational directory only").
2. Under **Token configuration → Add groups claim**, choose **Security groups** and **Group ID** for the ID token. (The Altman Pod registration likely has this already.)
3. Copy the **Application (client) ID** and **Directory (tenant) ID**. Create a **client secret** if you need a new one.
4. Open `staticwebapp.config.json` and replace `YOUR_TENANT_ID` with the Directory (tenant) ID.
5. Pick the Microsoft group whose members should see the report and copy its **Object ID** (Entra ID → Groups).

### 3. Storage
Use the same storage account as the Altman Pod site or create one (Storage accounts → Create). Copy its **connection string** from **Security + networking → Access keys**. The site creates its own `surrenders` table, so it won't touch the Altman Pod data.

### 4. Create the Static Web App
1. Azure portal → **Static Web Apps → Create**, **Standard** plan.
2. Source: GitHub, your new repository, branch `main`.
3. Build details: Custom. App location `/`, API location `api`, Output location empty.
4. After it builds, copy the site URL from **Overview**.
5. In the app registration → **Authentication**, add the redirect URI `https://<site address>/.auth/login/aad/callback`.

### 5. Settings (Static Web App → Settings → Environment variables)

| Name | Value |
|---|---|
| `AAD_CLIENT_ID` | Application (client) ID |
| `AAD_CLIENT_SECRET` | Client secret value |
| `ALLOWED_GROUP_ID` | Object ID of the group allowed in |
| `ADMIN_EMAILS` | Optional. Comma-separated emails always allowed in |
| `STORAGE_CONNECTION_STRING` | Storage connection string |
| `WEBHOOK_SECRET` | A long random password you make up. HubSpot sends it with every update |

### 6. The HubSpot workflow (someone with permission to create workflows)
The easiest way is to **clone the Altman Pod workflow** and change it, so it matches what already works. The settings to end up with:

- **Type:** deal-based workflow, named "Surrenders website feed".
- **Enrollment:** deals where **Surrender Date is known**. Turn on **re-enrollment** so a deal is sent again when any of these change: Surrender Date, Surrendered, Surrender Coordinator, Deal Stage, Pipeline, Surrender Time, Surrender Packet Completed, Paid at Surrender, Surrender Notes, Handling Attorney. When you turn the workflow on, choose to **enroll existing deals** that meet the criteria. That loads the history.
- **Action:** **Send a webhook**
  - Method: **POST**
  - URL: `https://<site address>/api/ingest`
  - Authentication: **API key**, key name `x-webhook-secret`, value = your `WEBHOOK_SECRET`, sent in the request header. If that option isn't offered, use the URL `https://<site address>/api/ingest?secret=<your WEBHOOK_SECRET>` instead.
  - Request body: **customize** and include these deal properties, using these names as keys: `hs_object_id`, `clio_matter`, `dealname`, `surrender_date`, `surrender_time`, `surrendered`, `surrender_coodinator`, `surrender_coordinator_text`, `dealstage`, `pipeline`, `handling_attorney`, `surrender_notes`, `surrender_packet_completed`, `paid_at_surrender`. If customizing isn't possible, the default full-record body also works.

### 7. Test
1. Open the site and sign in. The top right shows when the last HubSpot update arrived.
2. Change a surrender date on a test deal in HubSpot. Within a minute or two, it should appear on the site.
3. Sign in as someone outside the group. They should see the "no access" page.

## Notes
- **Freshness:** the site is as current as the workflow. Updates usually arrive within a minute of the change in HubSpot.
- **Removed deals:** if a deal's surrender date is cleared, the site removes it. Deals deleted outright in HubSpot stay on the site until removed from the `surrenders` table in Azure Storage.
