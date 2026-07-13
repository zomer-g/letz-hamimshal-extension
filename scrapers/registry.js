// URL → scraper dispatch. Mirrors govscraper/scrapers/registry.py.
// Order matters: specific matchers before general (govmap & nadlan before govil).

import { govmapScraper } from './govmap.js';
import { nadlanScraper } from './nadlan.js';
import { govilScraper } from './govil.js';
import { idfScraper } from './idf.js';
import { mavatScraper } from './mavat.js';
import { motScraper } from './mot.js';
import { jlmScraper } from './jlm.js';
import { knessetScraper } from './knesset.js';
import { landScraper } from './land.js';

const ALL = [govmapScraper, nadlanScraper, idfScraper, mavatScraper, motScraper, jlmScraper, knessetScraper, landScraper, govilScraper];

export function dispatchByUrl(href) {
  for (const s of ALL) {
    const parsed = s.parseUrl(href);
    if (parsed) return { scraper: s, parsed };
  }
  return null;
}

export function getById(id) {
  return ALL.find(s => s.id === id) || null;
}

export function allScrapers() {
  return ALL.slice();
}
