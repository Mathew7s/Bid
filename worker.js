// ============================================================================
// CRETE Systems — Cloudflare Worker API (single-file bundle)
// This is index.js + zefix.js + tenders.js + scraper.js combined into one
// file with all import/export statements removed, so it can be pasted
// directly into the Cloudflare dashboard's Worker code editor (which only
// supports a single file — no ES module resolution across files).
//
// No Cron Trigger: every refresh (Hunter "Run Scan", Bid Pulse "Run Scan")
// is user-initiated and fetches live data synchronously, then persists it.
// ============================================================================

// ---------------------------------------------------------------------------
// ZEFIX — Swiss Central Business Names Index (from src/zefix.js)
// ---------------------------------------------------------------------------
const ZEFIX_SEARCH_URL = 'https://www.zefix.ch/ZefixPublicREST/api/v1/company/search';

const ZEFIX_KEYWORDS = [
  'SMT', 'Elektronik', 'Electronique', 'Elettronica',
  'Montage', 'Automatisation', 'Automatisierung',
  'Leiterplatten', 'PCB', 'Semiconductor', 'Halbleiter'
];

async function fetchZefixAlerts(env) {
  const results = [];
  for (const kw of ZEFIX_KEYWORDS) {
    try {
      const res = await fetch(ZEFIX_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ name: kw, languageKey: 'en', maxEntries: 20 })
      });
      if (!res.ok) {
        console.warn(`ZEFIX ${kw}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      if (Array.isArray(data)) {
        for (const c of data) results.push(c);
      }
    } catch (e) {
      console.warn(`ZEFIX fetch error for "${kw}":`, e.message);
    }
  }
  const byUid = new Map();
  for (const c of results) {
    const uid = c.uid || c.ehraid || c.chid;
    if (uid && !byUid.has(uid)) byUid.set(uid, c);
  }
  return [...byUid.values()];
}

function zefixToAlert(company) {
  const uid = (company.uid || company.ehraid || company.chid || '').toString();
  const canton = company.canton || company.registryOffice?.canton || 'CH';
  return {
    id: 'zefix_' + uid.replace(/[^a-zA-Z0-9]/g, ''),
    priority: 'MEDIUM',
    company: company.name,
    industry: 'Manufacturing / Electronics',
    cluster: canton,
    location: `${company.town || ''} (${canton})`.trim(),
    signal_source: 'ZEFIX Company Registry — active registration',
    alert_signal: 'New/Active ZEFIX Registration',
    signal_summary: `Active company matching electronics/manufacturing keywords: ${company.name}`,
    predicted_requirement: 'Potential SMT/PCB equipment customer — requires manual qualification.',
    rfp_window: '6-12 months',
    lead_time_months: 9,
    deal_value_est: null,
    detected_days_ago: 0,
    status: 'open',
    next_steps: 'Research',
    sales_person: 'Unassigned',
    date_identified: new Date().toISOString().split('T')[0],
    notes: 'Sourced from ZEFIX (no-credential search). Requires qualification before outreach.',
    raw_json: JSON.stringify(company)
  };
}

// ---------------------------------------------------------------------------
// SIMAP + TED tenders (from src/tenders.js)
// ---------------------------------------------------------------------------
const SIMAP_BASE = 'https://www.simap.ch/api';
const TED_SEARCH_URL = 'https://ted.europa.eu/api/v2.0/notices/search';

const CPV_CODES = ['31700000', '31710000', '42931100'];

function fitScore(title) {
  const t = (title || '').toLowerCase();
  let score = 40;
  if (t.includes('smt')) score += 30;
  if (t.includes('pcb') || t.includes('leiterplatte') || t.includes('circuit')) score += 25;
  if (t.includes('assembly') || t.includes('montage')) score += 10;
  if (t.includes('electronic') || t.includes('elektronik')) score += 10;
  return Math.min(99, score);
}

async function fetchSimapTenders() {
  const out = [];
  try {
    const url = `${SIMAP_BASE}/publications/v1/publications?cpv=${CPV_CODES.join(',')}&status=active&size=50`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.warn(`SIMAP publications: HTTP ${res.status}`);
      return out;
    }
    const data = await res.json();
    const items = data.content || data.items || data.results || (Array.isArray(data) ? data : []);
    for (const it of items) {
      const title = it.title || it.projectTitle || it.name || 'Untitled tender';
      out.push({
        id: 'simap_' + (it.id || it.publicationId || title.slice(0, 40)).toString().replace(/\s+/g, '_'),
        source: 'SIMAP',
        tender_name: title,
        category: it.cpvDescription || 'Electronics / SMT',
        region: it.canton || 'Switzerland',
        country: 'CH',
        deadline: it.submissionDeadline || it.deadline || null,
        fit_score: fitScore(title),
        url: it.url || `https://www.simap.ch/shabforms/servlet/Search?publicationId=${it.id || ''}`,
        raw_json: JSON.stringify(it)
      });
    }
  } catch (e) {
    console.warn('SIMAP fetch error:', e.message);
  }
  return out;
}

async function fetchSimapAwards() {
  try {
    const res = await fetch(`${SIMAP_BASE}/procoffices/v1/po/public?cpv=${CPV_CODES.join(',')}&size=25`, {
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.content || data.items || (Array.isArray(data) ? data : []);
  } catch (e) {
    console.warn('SIMAP awards fetch error:', e.message);
    return [];
  }
}

const EU_ISO2 = new Set(['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','CH','LI','NO','IS']);
function isEuOrSwiss(code) {
  if (!code) return true;
  return EU_ISO2.has(code.toUpperCase().slice(0, 2));
}

async function fetchTedTenders() {
  const out = [];
  try {
    const res = await fetch(TED_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: `classification-cpv IN (${CPV_CODES.join(' ')})`,
        fields: ['ND', 'TI', 'PD', 'DD', 'CY', 'RN'],
        page: 1,
        limit: 50
      })
    });
    if (!res.ok) {
      console.warn(`TED search: HTTP ${res.status}`);
      return out;
    }
    const data = await res.json();
    const items = data.notices || data.results || [];
    for (const it of items) {
      const country = it.CY || it.country || '';
      if (!isEuOrSwiss(country)) continue;
      const title = it.TI || it.title || 'Untitled tender';
      out.push({
        id: 'ted_' + (it.ND || it.noticeId || title.slice(0, 40)).toString().replace(/\s+/g, '_'),
        source: 'TED',
        tender_name: title,
        category: 'Electronics / SMT (EU)',
        region: country,
        country,
        deadline: it.DD || it.deadline || null,
        fit_score: fitScore(title),
        url: it.url || `https://ted.europa.eu/udl?uri=TED:NOTICE:${it.ND || ''}:TEXT`,
        raw_json: JSON.stringify(it)
      });
    }
  } catch (e) {
    console.warn('TED fetch error:', e.message);
  }
  return out;
}

async function fetchAllTenders() {
  const [simap, ted] = await Promise.all([fetchSimapTenders(), fetchTedTenders()]);
  return [...simap, ...ted].sort((a, b) => b.fit_score - a.fit_score).slice(0, 15);
}

// ---------------------------------------------------------------------------
// Bid Pulse signal scraper (from src/scraper.js)
// ---------------------------------------------------------------------------
const SIGNAL_KEYWORDS = [
  'SMT', 'PCB', 'Leiterplatte', 'Elektronikmontage', 'Reinraum', 'cleanroom',
  'automatisierte Fertigung', 'Halbleiter', 'Baugenehmigung Produktionshalle'
];

const SOURCES = [
  {
    name: 'jobs.ch',
    url: 'https://www.jobs.ch/en/vacancies/?term=SMT%20Elektronik',
    itemSelector: 'a[class*="job"]',
    kind: 'hiring'
  },
  {
    name: 'Kantonales Amtsblatt (SO example)',
    url: 'https://www.publikationsplattform.ch/#!/search?text=Elektronik',
    itemSelector: 'a.result-title',
    kind: 'permit'
  }
];

class ItemCollector {
  constructor() { this.items = []; this._buf = ''; }
  text(t) { this._buf += t.text; }
  element(el) {
    if (this._buf.trim()) { this.items.push(this._buf.trim()); }
    this._buf = '';
  }
}

async function scrapeSource(source) {
  const found = [];
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': 'CRETE-BidPulse-Scanner/1.0 (+public-signal-scan)' }
    });
    if (!res.ok) {
      console.warn(`Scrape ${source.name}: HTTP ${res.status}`);
      return found;
    }
    const collector = new ItemCollector();
    const rewriter = new HTMLRewriter().on(source.itemSelector, collector);
    const transformed = rewriter.transform(res);
    await transformed.text();

    for (const raw of collector.items) {
      const hit = SIGNAL_KEYWORDS.find(k => raw.toLowerCase().includes(k.toLowerCase()));
      if (hit) {
        found.push({ source: source.name, kind: source.kind, keyword: hit, snippet: raw.slice(0, 160) });
      }
    }
  } catch (e) {
    console.warn(`Scrape error (${source.name}):`, e.message);
  }
  return found;
}

async function scrapeAllSignals() {
  const results = await Promise.all(SOURCES.map(scrapeSource));
  return results.flat();
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}

function buildAlertFromHit(hit) {
  const hash = simpleHash(hit.source + hit.snippet);
  return {
    id: 'scan_' + hash,
    priority: hit.kind === 'permit' ? 'HIGH' : 'MEDIUM',
    company: 'Unidentified — see snippet',
    industry: 'Electronics / Manufacturing (unconfirmed)',
    cluster: 'GE',
    location: 'Switzerland',
    signal_source: hit.source,
    alert_signal: hit.kind === 'permit' ? 'Building/Zoning Filing Keyword Match' : 'Hiring Spike Keyword Match',
    signal_summary: hit.snippet,
    predicted_requirement: 'Unconfirmed — requires manual review of source listing.',
    rfp_window: 'Unknown',
    lead_time_months: null,
    deal_value_est: null,
    detected_days_ago: 0,
    status: 'open',
    next_steps: 'Research',
    sales_person: 'Unassigned',
    date_identified: new Date().toISOString().split('T')[0],
    notes: `Auto-scraped keyword match ("${hit.keyword}"). Verify company identity before outreach.`,
    raw_json: JSON.stringify(hit)
  };
}

// ---------------------------------------------------------------------------
// Worker entry — REST API router (from src/index.js)
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

function nowISO() { return new Date().toISOString(); }

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const db = env.DB;

    try {
      // ---------------- Company info ----------------
      if (path === '/api/company' && request.method === 'GET') {
        const row = await db.prepare('SELECT * FROM company WHERE id = 1').first();
        return json(row || {});
      }
      if (path === '/api/company' && request.method === 'PUT') {
        const body = await request.json();
        await db.prepare(
          `INSERT INTO company (id, name, address, contact, updated_at) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, address=excluded.address, contact=excluded.contact, updated_at=excluded.updated_at`
        ).bind(body.name, body.address, body.contact, nowISO()).run();
        return json({ ok: true });
      }

      // ---------------- Bid status / WIP bids ----------------
      if (path === '/api/bids' && request.method === 'GET') {
        const { results } = await db.prepare('SELECT * FROM bids_wip ORDER BY updated_at DESC').all();
        return json(results);
      }
      if (path === '/api/bids' && request.method === 'POST') {
        const b = await request.json();
        const at = nowISO();
        await db.prepare(
          `INSERT INTO bids_wip (key, tender_name, region, status, status_at, order_details, next_action, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET tender_name=excluded.tender_name, region=excluded.region,
             status=excluded.status, status_at=excluded.status_at, order_details=excluded.order_details,
             next_action=excluded.next_action, notes=excluded.notes, updated_at=excluded.updated_at`
        ).bind(b.key, b.tender_name, b.region || null, b.status || 'draft', at,
               JSON.stringify(b.order_details || {}), b.next_action || null, b.notes || null, at, at).run();
        await db.prepare('INSERT INTO bid_status_history (bid_key, status, note, changed_at) VALUES (?, ?, ?, ?)')
          .bind(b.key, b.status || 'draft', b.notes || null, at).run();
        return json({ ok: true });
      }
      const bidMatch = path.match(/^\/api\/bids\/([^/]+)\/status$/);
      if (bidMatch && request.method === 'PUT') {
        const key = decodeURIComponent(bidMatch[1]);
        const { status, note } = await request.json();
        const at = nowISO();
        await db.prepare('UPDATE bids_wip SET status = ?, status_at = ?, updated_at = ? WHERE key = ?')
          .bind(status, at, at, key).run();
        await db.prepare('INSERT INTO bid_status_history (bid_key, status, note, changed_at) VALUES (?, ?, ?, ?)')
          .bind(key, status, note || null, at).run();
        return json({ ok: true });
      }

      // ---------------- Hunter tenders ----------------
      if (path === '/api/hunter' && request.method === 'GET') {
        const { results } = await db.prepare('SELECT * FROM hunter_tenders ORDER BY fit_score DESC LIMIT 15').all();
        const lastScan = await db.prepare(
          "SELECT finished_at FROM scan_log WHERE scan_type = 'hunter' AND status = 'success' ORDER BY finished_at DESC LIMIT 1"
        ).first();
        return json({ tenders: results, lastUpdated: lastScan?.finished_at || null });
      }
      if (path === '/api/hunter/scan' && request.method === 'POST') {
        const startedAt = nowISO();
        let tenders = [];
        let status = 'success';
        let detail = '';
        try {
          tenders = await fetchAllTenders();
          for (const t of tenders) {
            await db.prepare(
              `INSERT INTO hunter_tenders (id, source, tender_name, category, region, country, deadline, fit_score, url, raw_json, first_seen_at, last_seen_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET deadline=excluded.deadline, fit_score=excluded.fit_score, last_seen_at=excluded.last_seen_at`
            ).bind(t.id, t.source, t.tender_name, t.category, t.region, t.country, t.deadline, t.fit_score, t.url, t.raw_json, startedAt, startedAt).run();
          }
        } catch (e) {
          status = 'error'; detail = e.message;
        }
        const finishedAt = nowISO();
        await db.prepare(
          `INSERT INTO scan_log (scan_type, triggered_by, sources, new_records, status, detail, started_at, finished_at)
           VALUES ('hunter', 'user', ?, ?, ?, ?, ?, ?)`
        ).bind(JSON.stringify(['SIMAP', 'TED']), tenders.length, status, detail, startedAt, finishedAt).run();

        const { results } = await db.prepare('SELECT * FROM hunter_tenders ORDER BY fit_score DESC LIMIT 15').all();
        return json({ tenders: results, lastUpdated: finishedAt, newCount: tenders.length, status });
      }

      // ---------------- Bid Pulse alerts ----------------
      if (path === '/api/bidpulse' && request.method === 'GET') {
        const { results } = await db.prepare('SELECT * FROM bid_pulse_alerts ORDER BY created_at DESC').all();
        const lastScan = await db.prepare(
          "SELECT finished_at FROM scan_log WHERE scan_type = 'bidpulse' AND status = 'success' ORDER BY finished_at DESC LIMIT 1"
        ).first();
        return json({ alerts: results, lastUpdated: lastScan?.finished_at || null });
      }
      if (path === '/api/bidpulse/scan' && request.method === 'POST') {
        const startedAt = nowISO();
        let newAlerts = [];
        let status = 'success';
        let detail = '';
        try {
          const [zefixCompanies, scrapeHits] = await Promise.all([
            fetchZefixAlerts(env),
            scrapeAllSignals()
          ]);
          newAlerts = [
            ...zefixCompanies.map(zefixToAlert),
            ...scrapeHits.map(buildAlertFromHit)
          ];
          for (const a of newAlerts) {
            await db.prepare(
              `INSERT INTO bid_pulse_alerts (id, priority, company, industry, cluster, location, signal_source, alert_signal,
                signal_summary, predicted_requirement, rfp_window, lead_time_months, deal_value_est, detected_days_ago,
                status, next_steps, sales_person, date_identified, notes, raw_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO NOTHING`
            ).bind(a.id, a.priority, a.company, a.industry, a.cluster, a.location, a.signal_source, a.alert_signal,
                   a.signal_summary, a.predicted_requirement, a.rfp_window, a.lead_time_months, a.deal_value_est,
                   a.detected_days_ago, a.status, a.next_steps, a.sales_person, a.date_identified, a.notes, a.raw_json,
                   startedAt, startedAt).run();
          }
        } catch (e) {
          status = 'error'; detail = e.message;
        }
        const finishedAt = nowISO();
        await db.prepare(
          `INSERT INTO scan_log (scan_type, triggered_by, sources, new_records, status, detail, started_at, finished_at)
           VALUES ('bidpulse', 'user', ?, ?, ?, ?, ?, ?)`
        ).bind(JSON.stringify(['ZEFIX', 'public-scrape']), newAlerts.length, status, detail, startedAt, finishedAt).run();

        const { results } = await db.prepare('SELECT * FROM bid_pulse_alerts ORDER BY created_at DESC').all();
        return json({ alerts: results, lastUpdated: finishedAt, newCount: newAlerts.length, status });
      }
      const pulseMatch = path.match(/^\/api\/bidpulse\/([^/]+)$/);
      if (pulseMatch && request.method === 'PUT') {
        const id = decodeURIComponent(pulseMatch[1]);
        const body = await request.json();
        const fields = ['status', 'next_steps', 'sales_person', 'notes'];
        const sets = fields.filter(f => body[f] !== undefined);
        if (sets.length) {
          await db.prepare(`UPDATE bid_pulse_alerts SET ${sets.map(f => f + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`)
            .bind(...sets.map(f => body[f]), nowISO(), id).run();
        }
        return json({ ok: true });
      }

      // ---------------- Notes (shared journal for bids / tenders / alerts) ----------------
      if (path === '/api/notes' && request.method === 'POST') {
        const { entity_type, entity_id, note } = await request.json();
        await db.prepare('INSERT INTO notes (entity_type, entity_id, note, created_at) VALUES (?, ?, ?, ?)')
          .bind(entity_type, entity_id, note, nowISO()).run();
        return json({ ok: true });
      }
      const notesMatch = path.match(/^\/api\/notes\/([^/]+)\/([^/]+)$/);
      if (notesMatch && request.method === 'GET') {
        const [, entity_type, entity_id] = notesMatch;
        const { results } = await db.prepare(
          'SELECT * FROM notes WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC'
        ).bind(entity_type, decodeURIComponent(entity_id)).all();
        return json(results);
      }

      // ---------------- Scan / sync history (tracking) ----------------
      if (path === '/api/history' && request.method === 'GET') {
        const { results } = await db.prepare('SELECT * FROM scan_log ORDER BY started_at DESC LIMIT 50').all();
        return json(results);
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
  // NOTE: intentionally no `scheduled()` export — this Worker has no Cron
  // Trigger. Every data refresh is initiated by the user via the "Run Scan"
  // buttons (POST /api/hunter/scan and POST /api/bidpulse/scan).
};
