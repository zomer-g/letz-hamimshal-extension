# GovScraper — Privacy Policy

_Last updated: 2026-06-09_

## What this extension does
GovScraper detects when the page you are visiting on www.gov.il, www.nadlan.gov.il, or www.govmap.gov.il hosts an open dataset, and offers a one-click download of that dataset as a CSV or ZIP file directly from your browser.

## What data is collected
**Nothing is collected by us.** All data the extension touches stays inside your browser.

Specifically:
- **Dataset rows fetched from gov.il APIs**: built into a CSV/ZIP and delivered to your local Downloads folder. The bytes never leave your machine.
- **Download history** (last 50 items: page URL, dataset name, row count, timestamp): stored in `chrome.storage.local` for display in the toolbar popup. Stored only in your browser profile; never synced or uploaded.
- **Preferences** ("hide overlay today", "enable over.org.il fallback"): stored in `chrome.storage.local` on your device.

## What is not collected
The extension does **not** collect, transmit, sell, or share:
- Browsing history outside the three supported gov.il hosts
- Page content from any site other than www.gov.il, www.nadlan.gov.il, www.govmap.gov.il
- Personally identifiable information (name, email, phone, address)
- Authentication credentials of any kind
- Financial information
- Location data beyond what is contained in public GovMap layers you explicitly scrape

## Optional external fallback
The extension contains an opt-in feature flag (off by default) named "Send to external processor". When you explicitly enable it in the toolbar popup, an additional button appears in the overlay. Clicking that button sends only the **current page URL** to https://over.org.il for processing by their public scrape pipeline. No other data is sent.

If you never enable this flag, the extension makes zero network requests to any non-gov.il destination.

## Third parties
None. The extension has no analytics, no error reporting, no telemetry of any kind.

## How to clear stored data
Open the extension's toolbar popup and click "Clear history". To wipe all preferences, remove the extension from chrome://extensions.

## Canonical hosted version
The authoritative, always-current version of this policy is published at
https://www.z-g.co.il/govscraper/privacy (terms of use: https://www.z-g.co.il/govscraper/terms).

## Contact
guy@z-g.co.il
