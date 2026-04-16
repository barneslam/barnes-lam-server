'use strict';
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://qiwdgyilhwkndqkgqruf.supabase.co';
const SUPABASE_KEY      = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFpd2RneWlsaHdrbmRxa2dxcnVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTc4NDcsImV4cCI6MjA5MTY3Mzg0N30.bEhiitzcDMOpViFFtBhfbUKcHVDah8t7DvsNlTxaOEk';
const ANTHROPIC_KEY     = process.env.ANTHROPIC_API_KEY || '';
const DEEPGRAM_KEY      = process.env.DEEPGRAM_API_KEY  || '91fd82f8ab74a50a0784babd083ff9a24f18fdab';
const ELEVENLABS_KEY    = process.env.ELEVENLABS_API_KEY  || '';
const ELEVENLABS_VOICE  = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const FATHOM_KEY        = process.env.FATHOM_API_KEY    || '2aPN-Af79yOWj-PAIdGH1A.YjIym7YNtwzPjSRRrwK4WU3WPmedRP0DNHusDkfhaWU';

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

// ── Supabase REST helper ──────────────────────────────────────────────────────
function supaRequest(method, path, body, extra = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + '/rest/v1/' + path);
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...extra
    };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request({
      hostname: url.hostname, port: 443,
      path: url.pathname + url.search,
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

async function dbGet(table, query = '') {
  const { data } = await supaRequest('GET', `${table}?${query}`);
  return Array.isArray(data) ? data : (data ? [data] : []);
}

async function dbUpsert(table, rows) {
  const body = Array.isArray(rows) ? rows : [rows];
  await supaRequest('POST', table, body, { 'Prefer': 'resolution=merge-duplicates,return=minimal' });
}

async function dbGetOne(table, query = '') {
  const rows = await dbGet(table, query + '&limit=1');
  return rows[0] || null;
}

// ── Supabase session helpers ──────────────────────────────────────────────────
async function loadSessions() {
  return dbGet('bl_sessions', 'order=date.desc');
}
async function saveSessions(sessions) {
  if (!sessions.length) return;
  await dbUpsert('bl_sessions', sessions.map(s => ({
    id: s.id, title: s.title, date: s.date, duration: s.duration,
    participants: s.participants || [], transcript: s.transcript || '',
    summary: s.summary || '', action_items: s.actionItems || [],
    share_url: s.shareUrl || '', fathom_url: s.fathomUrl || ''
  })));
}
async function loadPersona() {
  const row = await dbGetOne('bl_persona', 'id=eq.1&select=data,built_at');
  return row ? { ...row.data, builtAt: row.built_at } : null;
}
async function savePersona(data) {
  await dbUpsert('bl_persona', { id: 1, data, built_at: new Date().toISOString() });
}
async function loadMemory() {
  const row = await dbGetOne('bl_memory', 'id=eq.1&select=data,updated_at');
  return row ? { ...row.data, lastUpdated: row.updated_at } : null;
}
async function saveMemory(data) {
  await dbUpsert('bl_memory', { id: 1, data, updated_at: new Date().toISOString() });
}
async function loadEmails() {
  return dbGet('bl_emails', 'order=date.desc');
}
async function countSessions() {
  const { data } = await supaRequest('GET', 'bl_sessions?select=id&limit=1', null, { 'Prefer': 'count=exact' });
  return Array.isArray(data) ? data.length : 0; // approximate; full count needs HEAD
}

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

// ── RAG ───────────────────────────────────────────────────────────────────────
function scoreSession(s, query) {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 2);
  const title = (s.title || '').toLowerCase();
  const body = (s.transcript || '').toLowerCase();
  let score = 0;
  for (const w of words) {
    score += (title.match(new RegExp(w, 'g')) || []).length * 5;
    score += Math.min((body.match(new RegExp(w, 'g')) || []).length, 20);
  }
  const age = Date.now() - new Date(s.date).getTime();
  if (age < 90 * 86400000) score += 10;
  return score;
}

function searchSessions(sessions, query, topK = 5) {
  return sessions
    .filter(s => s.transcript)
    .map(s => ({ s, score: scoreSession(s, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(r => r.score > 0)
    .map(r => r.s);
}

function buildContext(sessions, maxChars = 1500) {
  return sessions.map(s =>
    `--- [${(s.date || '').substring(0,10)}] ${s.title} (${s.duration} min) ---\n` +
    `Participants: ${(s.participants || []).join(', ')}\n` +
    (s.transcript || '').substring(0, maxChars)
  ).join('\n\n');
}

// ── Persona system prompt ─────────────────────────────────────────────────────
async function getSystemPrompt() {
  const persona = await loadPersona();
  let base = `You are Barnes Lam — responding based on your actual recorded sessions and thinking. You speak in first person as Barnes.\n\nBe direct, practical, and grounded. Draw on real patterns from the transcripts provided. Don't be generic.`;
  if (persona) {
    base += `\n\nYOUR COMMUNICATION STYLE: ${persona.communicationStyle}
YOUR CORE VALUES: ${(persona.coreValues || []).join(', ')}
YOUR FRAMEWORKS: ${(persona.frameworks || []).join(', ')}
HOW YOU MAKE DECISIONS: ${persona.decisionPattern}
YOUR CHARACTERISTIC PHRASES: ${(persona.characteristicPhrases || []).join(', ')}`;
  }
  return base;
}

module.exports = {
  ok, err, preflight, CORS,
  loadSessions, saveSessions, loadPersona, savePersona, loadMemory, saveMemory, loadEmails,
  fetchAllFathom, fathomToSession,
  callClaude, callDeepgram, callElevenLabs,
  searchSessions, buildContext, getSystemPrompt,
  ELEVENLABS_KEY
};
