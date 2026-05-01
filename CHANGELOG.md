# Change Log

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
