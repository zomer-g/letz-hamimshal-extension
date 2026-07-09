// Client for the over.org.il public dispatch endpoint.
//
// The endpoint does NOT exist yet — see plan §"Server fallback". This client
// is wired up but gated by a feature flag in chrome.storage so the toolbar
// button stays hidden until over.org.il ships the route.

const DISPATCH_URL = 'https://over.org.il/api/extension/dispatch';

export async function dispatchToOverOrg({ sourceUrl, scraperHint }) {
  const resp = await fetch(DISPATCH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source_url: sourceUrl,
      scraper_hint: scraperHint,
    }),
  });
  if (!resp.ok) {
    throw new Error(`over.org.il dispatch failed: HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return {
    trackedDatasetId: data.tracked_dataset_id || null,
    statusUrl: data.status_url || null,
    expectedEtaSeconds: data.expected_eta_seconds || null,
  };
}

export async function isFallbackEnabled() {
  try {
    const { 'featureFlag.overOrgFallback': enabled } = await chrome.storage.local.get('featureFlag.overOrgFallback');
    return !!enabled;
  } catch {
    return false;
  }
}
