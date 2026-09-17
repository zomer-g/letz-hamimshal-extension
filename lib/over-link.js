// "גרסאות לעם" (OVER, over.org.il) deep links.
//
// OVER resolves a dataset BY ITS SOURCE ADDRESS: over.org.il/direct/<page url>.
// If OVER already archives whatever lives at that address it opens the tracked
// dataset (with full history + full geometry); if it doesn't, the page offers
// the visitor a way to ask for it to be archived. That makes it the right thing
// to point at whenever this extension can't collect a page in full.
//
// The target URL is appended VERBATIM — not percent-encoded. That is the shape
// OVER's route expects (see over.org.il/direct/https://www.govmap.gov.il/?c=…&lay=11):
// the target's query string stays a real query string on the resulting URL.

export const OVER_HOME = 'https://www.over.org.il/';
const DIRECT_PREFIX = 'https://over.org.il/direct/';

// Build the /direct/ link for a page. Falls back to OVER's home page for
// anything that isn't a normal web address (chrome://, about:blank, empty),
// so a CTA built from this is never a dead link.
export function overDirectUrl(pageUrl) {
  const s = String(pageUrl == null ? '' : pageUrl).trim();
  if (!/^https?:\/\//i.test(s)) return OVER_HOME;
  return DIRECT_PREFIX + s;
}

// Search OVER by a dataset's name — the secondary route when the address-based
// lookup misses (e.g. the layer is archived under a different source URL).
export function overSearchUrl(query) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return OVER_HOME;
  return OVER_HOME + '?q=' + encodeURIComponent(q);
}
