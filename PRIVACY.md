# Privacy Policy

Last updated: April 2026

## Overview

The Britive browser extensions allow users to manage cloud access profiles, act on approval requests, and retrieve secrets from their organization's Britive tenant directly in the browser. This policy describes how the extension handles user data.

## Data Collected

The extension stores the following data locally in your browser using the browser's built-in extension storage API:

- **Authentication tokens:** OAuth access tokens, and refresh tokens in Chrome, used to maintain your authenticated session with your Britive tenant.
- **Tenant configuration:** Your Britive tenant name, used to connect to `<tenant name>.britive-app.com`.
- **User preferences:** Theme selection, zoom level, notification settings, tab visibility, and other UI preferences.
- **Cached metadata:** Access profile names, approval request summaries, and secret names/paths are cached locally to improve load times. Secret values are fetched on demand and are not persisted.

## Data Transmission

The extension communicates exclusively with your organization's Britive tenant at `https://<tenant name>.britive-app.com`. This includes REST API calls and a WebSocket connection for real-time notifications.

No data is transmitted to Britive, the extension developers, or any other third party.

## Third-Party Sharing

The extension does not share, sell, or transfer any user data to third parties. No analytics, telemetry, or tracking of any kind is included in the extension.

## Data Storage

All data is stored locally in your browser using the extension storage API (`chrome.storage.local` or `browser.storage.local`). No data is stored on external servers by the extension.

A scoped authentication cookie is set on the WebSocket endpoint path (`/api/websocket/`) of your tenant domain to authenticate the real-time notification connection. This cookie is marked `HttpOnly` and `Secure`, restricted to the WebSocket path, and removed on logout.

## Data Retention and Deletion

- **Logout:** Clicking "Log Out" in the extension clears all stored tokens, cached data, and the WebSocket authentication cookie.
- **Uninstall:** Removing the extension from your browser deletes all extension storage and cookies automatically.
- **Manual:** You can clear extension data at any time through your browser's extension management settings.

## Permissions

| Permission | Justification |
|---|---|
| `storage` | Persist auth tokens, cached secrets, and settings |
| `tabs` | Open login and console tabs, manage popup focus intents, and support the Firefox container picker |
| `notifications` | Token expiration alerts |
| `alarms` | Periodic polling for banners and approvals |
| `cookies` | Set and clear the websocket auth cookie used for realtime notifications |
| `identity` | Run the browser-managed OAuth flow |
| `offscreen` | Keep the Chrome MV3 websocket client alive outside the popup |
| `declarativeNetRequest` | Apply the request header rule used by the Chrome build |
| `contextualIdentities` | Open Britive issued AWS STS, and/or user configured, URLs in Firefox containers |

## Remote Code

The extension does not load or execute any remote code. All JavaScript is included in the extension package. The extension makes data-only API calls to your Britive tenant but does not fetch or execute scripts from any external source.

## Changes to This Policy

If this privacy policy is updated, the changes will be published to this repository with an updated date above.

## Contact

If you have questions about this privacy policy or the extension's data practices, please reach out.
