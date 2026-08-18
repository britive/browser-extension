# Change Log

## v1.2.1 [2026-08-18]

__What's New:__

* None

__Enhancements:__

* None

__Bug Fixes:__

* Extension logout now removes only the WebSocket-scoped authentication cookie, preserving the separate Britive web UI session.
* My Secrets now follows cursor pagination so users can see secrets beyond the first API response page.
* Step-up TOTP checkout now retains the completion cookie, keeps the extension session active after a failed OTP, and applies successful authentication to the checkout retry.

__Dependencies:__

* None

__Other:__

* None

## v1.2.0 [2026-06-01]

__What's New:__

* Password Manager secrets can now be matched to the active site and autofilled on demand.
* Password Manager credentials can now be offered directly on login pages with a Britive inline autofill prompt.
* New pending approval requests can now generate native browser notifications for approvers.
* Notification delivery now uses the Britive WebSocket v2 endpoint with a periodic keepalive ping.

__Enhancements:__

* Password Manager autofill settings are now separate from My Secrets visible type settings.
* My Secrets defaults to Password Manager, Generic Web App, and Web App With OTP secret types.
* Password Manager autofill matches exact hostnames first and supports stored parent domains for active subdomains.
* Autofill can fill username, password, and OTP values when present in the selected Password Manager secret.
* The best Password Manager match can be autofilled from the keyboard with Ctrl+Shift+L, or Command+Shift+L on macOS.
* Checkout expiration notifications are restored more reliably after browser wake or background restart.
* My Access WebSocket notifications, popup toasts, and badge counts remain scoped to the current Favorites or selected collection.
* My Approvals remain unscoped so approvers see and receive notifications for all pending approvals.

__Bug Fixes:__

* Expired queued checkout notifications no longer keep stale badge counts or delayed popup toasts.
* Checkout expiration metadata is reconciled when profiles are no longer checked out.
* Password Manager autofill prompt rendering now avoids injecting secret metadata through HTML strings.

__Dependencies:__

* None

__Other:__

* Chrome adds the autofill permissions required for active-tab script execution, context menu access, and inline login-page credential offering.
* Firefox retains CLI auth tab auto-close support; Chrome continues to avoid the Web Store-rejected tabs permission.

## v1.1.0 [2026-05-01]

__What's New:__

* Firefox multi-account container interception now refreshes correctly after authentication state changes.

__Enhancements:__

* Active access state now distinguishes console checkouts from CLI/programmatic checkouts when rendering My Access.
* Firefox CLI auth tabs can auto-close after reaching the CLI-ready page.
* Notifications, popup toasts, and badge counts are scoped to the current My Access view.

__Bug Fixes:__

* Fixed Firefox checkout interception requiring a settings save before container selection started working.
* Fixed console profiles being shown as checked out when only a CLI or programmatic checkout was active.
* Fixed console open actions using non-console transaction IDs.
* Fixed console URL copy actions hanging in the popup.
* Removed Chrome CLI auto-close support to avoid the Chrome Web Store-rejected tabs permission.
* Fixed My Access text-button mode causing Open/Copy controls to overlap by keeping those compact buttons icon-only.

__Dependencies:__

* None

__Other:__

* Chrome manifest no longer requests the tabs permission.

## v1.0.0 [2026-04-06]

__What's New:__

* Everything, initial release.

__Enhancements:__

* None

__Bug Fixes:__

* None

__Dependencies:__

* None

__Other:__

* None
