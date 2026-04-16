'use strict';
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://vrdximjglfejmrsyvuxx.supabase.co';
const SUPABASE_KEY      = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZyZHhpbWpnbGZlam1yc3l2dXh4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzQ0NzQsImV4cCI6MjA5MTkxMDQ3NH0.zLYj76cS5IrsFoPDFCDBK_t69he4UaVUQcCX61ePsGI';
const ANTHROPIC_KEY     = process.env.ANTHROPIC_API_KEY || '';
const DEEPGRAM_KEY      = process.env.DEEPGRAM_API_KEY  || '91fd82f8ab74a50a0784babd083ff9a24f18fdab';
const ELEVENLABS_KEY    = process.env.ELEVENLABS_API_KEY  || '';
const ELEVENLABS_VOICE  = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const FATHOM_KEY        = process.env.FATHOM_API_KEY    || '2aPN-Af79yOWj-PAIdGH1A.YjIym7YNtwzPjSRRrwK4WU3WPmedRP0DNHusDkfhaWU';
const SB_HOST           = SUPABASE_URL.replace('https://', '');

// ── CORS headers ──────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json'
};

function ok(body, extra = {}) {
  return { statusCode: 200, headers: { ...CORS, ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) };
}
function err(msg, code = 500) {
  return { statusCode: code, headers: CORS, body: JSON.stringify({ success: false, error: msg }) };
}
function preflight() {
  return { statusCode: 204, headers: CORS, body: '' };
}

// ── Supabase bl_knowledge (single JSONB table) ────────────────────────────────
function supaRequest(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...extraHeaders
    };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request({
      hostname: SB_HOST, port: 443,
      path: '/rest/v1/' + path,
      method, headers
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }); }
        catch(e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function dbLoad(key, fallback = null) {
  const { data } = await supaRequest('GET', `bl_knowledge?key=eq.${encodeURIComponent(key)}&select=payload&limit=1`);
  const row = Array.isArray(data) ? data[0] : data;
  return (row && row.payload !== undefined) ? row.payload : fallback;
}

async function dbSave(key, payload) {
  await supaRequest('POST', 'bl_knowledge', { key, payload }, { 'Prefer': 'resolution=merge-duplicates,return=minimal' });
}

// ── Convenience wrappers ──────────────────────────────────────────────────────
const loadSessions  = () => dbLoad('sessions',  []);
const loadEmails    = () => dbLoad('emails',    []);
const loadPodcasts  = () => dbLoad('podcasts',  []);
const loadWebsite   = () => dbLoad('website',   []);
const loadPersonal  = () => dbLoad('personal',  null);
const loadPersona   = () => dbLoad('persona',   null);
const loadMemory    = () => dbLoad('memory',    null);

async function saveSessions(sessions) { await dbSave('sessions', sessions); }
async function savePersona(data)      { await dbSave('persona', data); }
async function saveMemory(data)       { await dbSave('memory', data); }
async function saveEmails(emails)     { await dbSave('emails', emails); }

// ── Fathom API ────────────────────────────────────────────────────────────────
function fathomPage(cursor) {
  return new Promise((resolve, reject) => {
    let path = '/external/v1/meetings?include_transcript=true&limit=50';
    if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
    const req = https.request(
      { hostname: 'api.fathom.ai', port: 443, path, method: 'GET',
        headers: { 'X-Api-Key': FATHOM_KEY } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }
    );
    req.on('error', reject); req.end();
  });
}

async function fetchAllFathom() {
  const all = []; let cursor = null; let page = 0;
  while (page < 20) {
    const result = await fathomPage(cursor);
    const items = result.items || [];
    all.push(...items);
    if (!result.next_cursor || items.length === 0) break;
    cursor = result.next_cursor; page++;
  }
  return all;
}

function fathomToSession(m) {
  const raw = m.transcript;
  const transcript = Array.isArray(raw)
    ? raw.map(t => `[${t.timestamp}] ${t.speaker?.display_name || 'Unknown'}: ${t.text}`).join('\n')
    : '';
  const participants = (m.calendar_invitees || []).map(i => i.name).filter(Boolean);
  const durationMs = m.recording_end_time && m.recording_start_time
    ? new Date(m.recording_end_time) - new Date(m.recording_start_time) : 0;
  return {
    id: String(m.recording_id),
    title: m.title || m.meeting_title || 'Untitled',
    date: m.recording_start_time || m.created_at,
    duration: Math.round(durationMs / 60000),
    participants, transcript,
    summary: m.default_summary || '',
    actionItems: m.action_items || [],
    shareUrl: m.share_url || '',
    fathomUrl: m.url || ''
  };
}

// ── Claude ────────────────────────────────────────────────────────────────────
function callClaude(systemPrompt, messages, maxTokens = 1200) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, system: systemPrompt, messages });
    const req = https.request({
      hostname: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).content?.find(b => b.type === 'text')?.text || ''); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

// ── Deepgram STT ──────────────────────────────────────────────────────────────
function callDeepgram(audioBuffer, contentType) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.deepgram.com', port: 443,
      path: '/v1/listen?model=nova-2&smart_format=true&language=en',
      method: 'POST',
      headers: { 'Authorization': `Token ${DEEPGRAM_KEY}`, 'Content-Type': contentType || 'audio/webm', 'Content-Length': audioBuffer.length }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d).results?.channels?.[0]?.alternatives?.[0]?.transcript || ''); }
        catch(e) { reject(new Error('Deepgram parse error')); }
      });
    });
    req.on('error', reject); req.write(audioBuffer); req.end();
  });
}

// ── ElevenLabs TTS ────────────────────────────────────────────────────────────
function callElevenLabs(text) {
  if (!ELEVENLABS_KEY) return Promise.reject(new Error('ELEVENLABS_API_KEY not configured'));
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text, model_id: 'eleven_turbo_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } });
    const req = https.request({
      hostname: 'api.elevenlabs.io', port: 443,
      path: `/v1/text-to-speech/${ELEVENLABS_VOICE}`,
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Accept': 'audio/mpeg' }
    }, (res) => {
      if (res.statusCode !== 200) {
        let e = ''; res.on('data', c => e += c); res.on('end', () => reject(new Error(`ElevenLabs ${res.statusCode}: ${e}`))); return;
      }
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

// ── RAG — unified scorer ──────────────────────────────────────────────────────
function scoreItem(item, query, titleField, bodyField) {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 2);
  const title = (item[titleField] || '').toLowerCase();
  const body  = (item[bodyField]  || '').toLowerCase();
  let score = 0;
  for (const w of words) {
    score += (title.match(new RegExp(w, 'g')) || []).length * 5;
    score += Math.min((body.match(new RegExp(w, 'g')) || []).length, 20);
  }
  const age = Date.now() - new Date(item.date).getTime();
  if (age < 90 * 86400000) score += 10;
  return score;
}

function searchSessions(sessions, query, topK = 5) {
  return sessions
    .filter(s => s.transcript)
    .map(s => ({ s, score: scoreItem(s, query, 'title', 'transcript') }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(r => r.score > 0)
    .map(r => r.s);
}

function searchEmails(emails, query, topK = 3) {
  return emails
    .map(e => ({ e, score: scoreItem(e, query, 'subject', 'body') }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(r => r.score > 0)
    .map(r => r.e);
}

function searchPodcasts(podcasts, query, topK = 3) {
  return podcasts
    .map(p => ({ p, score: scoreItem(p, query, 'title', 'description') }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(r => r.score > 0)
    .map(r => r.p);
}

function searchWebsite(website, query, topK = 2) {
  return website
    .map(w => ({ w, score: scoreItem(w, query, 'title', 'content') }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(r => r.score > 0)
    .map(r => r.w);
}

function searchPersonal(personal, query) {
  if (!personal) return null;
  const q = query.toLowerCase();
  const personalKeywords = ['family','personal','child','daughter','son','school',
    'home','car','insurance','mortgage','finance','legal','lawyer','health','life',
    'situation','challenge','transition','wylie','branksome','piano','bmw','accident',
    'aviva','rbc','appliance','condo','broadway','residence'];
  const hasPersonalQuery = personalKeywords.some(kw => q.includes(kw));
  const blob = JSON.stringify(personal).toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 2);
  const termMatch = words.some(w => blob.includes(w));
  return (hasPersonalQuery || termMatch) ? personal : null;
}

function buildContext(sessions, maxChars = 1500) {
  return sessions.map(s =>
    `--- [${(s.date || '').substring(0,10)}] ${s.title} (${s.duration} min) ---\n` +
    `Participants: ${(s.participants || []).join(', ')}\n` +
    (s.transcript || '').substring(0, maxChars)
  ).join('\n\n');
}

function buildEmailContext(emails) {
  return emails.map(e =>
    `--- EMAIL: ${e.subject} [${(e.date || '').substring(0,10)}] ---\nTo: ${e.to || ''}\n${(e.body || '').substring(0, 600)}`
  ).join('\n\n');
}

function buildPodcastContext(podcasts) {
  return podcasts.map(p =>
    `--- PODCAST: ${p.title} ---\n${(p.description || p.summary || '').substring(0, 500)}`
  ).join('\n\n');
}

function buildWebsiteContext(website) {
  return website.map(w =>
    `--- WEBSITE [${w.title}]: ${w.url || ''} ---\n${(w.content || '').substring(0, 600)}`
  ).join('\n\n');
}

function buildPersonalContext(personal) {
  if (!personal) return '';
  const child = personal.family?.child;
  const challenges = (personal.currentChallenges || [])
    .map(c => `${c.category}: ${c.summary}`).join('; ');
  return `YOUR PERSONAL CONTEXT:\n- Home: ${personal.residences?.primary || ''}\n` +
    (child ? `- Family: Child ${child.name} attends ${child.school}\n` : '') +
    (challenges ? `- Current challenges: ${challenges}\n` : '');
}

// ── System prompt ─────────────────────────────────────────────────────────────
async function getSystemPrompt() {
  const [persona, personal] = await Promise.all([loadPersona(), loadPersonal()]);
  let base = `You are Barnes Lam — responding based on your actual recorded sessions and thinking. You speak in first person as Barnes.\n\nBe direct, practical, and grounded. Draw on real patterns from the transcripts provided. Don't be generic.`;
  if (persona) {
    base += `\n\nYOUR COMMUNICATION STYLE: ${persona.communicationStyle}
YOUR CORE VALUES: ${(persona.coreValues || []).join(', ')}
YOUR FRAMEWORKS: ${(persona.frameworks || []).join(', ')}
HOW YOU MAKE DECISIONS: ${persona.decisionPattern}
YOUR CHARACTERISTIC PHRASES: ${(persona.characteristicPhrases || []).join(', ')}`;
  }
  if (personal) {
    base += '\n\n' + buildPersonalContext(personal);
  }
  return base;
}

module.exports = {
  ok, err, preflight, CORS,
  dbLoad, dbSave,
  loadSessions, loadEmails, loadPodcasts, loadWebsite, loadPersonal,
  loadPersona, loadMemory,
  saveSessions, savePersona, saveMemory, saveEmails,
  fetchAllFathom, fathomToSession,
  callClaude, callDeepgram, callElevenLabs,
  scoreItem, searchSessions, searchEmails, searchPodcasts, searchWebsite, searchPersonal,
  buildContext, buildEmailContext, buildPodcastContext, buildWebsiteContext, buildPersonalContext,
  getSystemPrompt,
  ELEVENLABS_KEY
};
