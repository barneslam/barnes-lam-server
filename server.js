#!/usr/bin/env node

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const FATHOM_API_KEY = process.env.FATHOM_API_KEY || '2aPN-Af79yOWj-PAIdGH1A.YjIym7YNtwzPjSRRrwK4WU3WPmedRP0DNHusDkfhaWU';
const DEEPGRAM_API_KEY   = process.env.DEEPGRAM_API_KEY   || '91fd82f8ab74a50a0784babd083ff9a24f18fdab';

// Mutable keys — can be updated at runtime via POST /api/config
let ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY   || '';
let ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY  || '';
let ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
let GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
let GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
let gmailTokens = {}; // { email: { accessToken, refreshToken, expiresAt } }

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── Supabase (knowledge base) ────────────────────────────────────────────────
const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://vrdximjglfejmrsyvuxx.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZyZHhpbWpnbGZlam1yc3l2dXh4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzQ0NzQsImV4cCI6MjA5MTkxMDQ3NH0.zLYj76cS5IrsFoPDFCDBK_t69he4UaVUQcCX61ePsGI';
const SB_HOST = SUPABASE_URL.replace('https://', '');

async function dbLoad(key, fallback) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: SB_HOST, port: 443,
      path: `/rest/v1/bl_knowledge?key=eq.${key}&select=payload`,
      method: 'GET',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const rows = JSON.parse(d);
          const val = rows?.[0]?.payload;
          resolve(val !== undefined && val !== null ? val : fallback);
        } catch { resolve(fallback); }
      });
    });
    req.on('error', () => resolve(fallback));
    req.end();
  });
}

async function dbSave(key, data) {
  return new Promise((resolve) => {
    const body = JSON.stringify([{ key, payload: data }]);
    const req = https.request({
      hostname: SB_HOST, port: 443,
      path: '/rest/v1/bl_knowledge',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Prefer': 'resolution=merge-duplicates',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

// ─── Config — env vars (primary) + Supabase fallback for runtime overrides ────
// API keys:    set as env vars in Railway/Fly dashboard (or via Settings modal → saved to Supabase)
// Gmail tokens: always stored in Supabase (oauth tokens change on every refresh)

async function initDataDir() {
  // Load runtime config from Supabase (overrides env vars only if env var is empty)
  const cfg = await dbLoad('runtime_config', {});
  if (!ANTHROPIC_API_KEY    && cfg.anthropicApiKey)    ANTHROPIC_API_KEY    = cfg.anthropicApiKey;
  if (!ELEVENLABS_API_KEY   && cfg.elevenLabsApiKey)   ELEVENLABS_API_KEY   = cfg.elevenLabsApiKey;
  if (cfg.elevenLabsVoiceId)                           ELEVENLABS_VOICE_ID  = cfg.elevenLabsVoiceId;
  if (!GOOGLE_CLIENT_ID     && cfg.googleClientId)     GOOGLE_CLIENT_ID     = cfg.googleClientId;
  if (!GOOGLE_CLIENT_SECRET && cfg.googleClientSecret) GOOGLE_CLIENT_SECRET = cfg.googleClientSecret;
  // Gmail OAuth tokens always come from Supabase
  const savedTokens = await dbLoad('gmail_tokens', {});
  if (savedTokens && typeof savedTokens === 'object') gmailTokens = savedTokens;
  console.log(`Config loaded. Gmail accounts: ${Object.keys(gmailTokens).join(', ') || 'none'}`);
}

async function persistConfig() {
  // Save runtime config overrides to Supabase
  const cfg = {};
  if (ANTHROPIC_API_KEY)    cfg.anthropicApiKey    = ANTHROPIC_API_KEY;
  if (ELEVENLABS_API_KEY)   cfg.elevenLabsApiKey   = ELEVENLABS_API_KEY;
  if (ELEVENLABS_VOICE_ID)  cfg.elevenLabsVoiceId  = ELEVENLABS_VOICE_ID;
  if (GOOGLE_CLIENT_ID)     cfg.googleClientId     = GOOGLE_CLIENT_ID;
  if (GOOGLE_CLIENT_SECRET) cfg.googleClientSecret = GOOGLE_CLIENT_SECRET;
  await dbSave('runtime_config', cfg);
  // Gmail tokens saved separately
  if (Object.keys(gmailTokens).length) await dbSave('gmail_tokens', gmailTokens);
}

// Kept for any legacy local reads
async function load(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf-8')); }
  catch { return fallback; }
}
async function save(file, data) {
  try { await fs.mkdir(path.dirname(file), { recursive: true }); } catch {}
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

// ─── Fathom API ───────────────────────────────────────────────────────────────
async function fetchFathomPage(cursor) {
  return new Promise((resolve, reject) => {
    let url = `/external/v1/meetings?include_transcript=true&limit=50`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const req = https.request(
      { hostname: 'api.fathom.ai', port: 443, path: url, method: 'GET',
        headers: { 'X-Api-Key': FATHOM_API_KEY },
        timeout: 15000 },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('Fathom API timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function fetchAllFathomMeetings() {
  const all = [];
  let cursor = null;
  let page = 0;
  while (page < 20) {
    const result = await fetchFathomPage(cursor);
    const items = result.items || [];
    all.push(...items);
    console.log(`  Fathom page ${page + 1}: ${items.length} meetings (total: ${all.length})`);
    if (!result.next_cursor || items.length === 0) break;
    cursor = result.next_cursor;
    page++;
  }
  return all;
}

function formatTranscript(raw) {
  if (!raw || !Array.isArray(raw)) return '';
  return raw.map(t => `[${t.timestamp}] ${t.speaker?.display_name || 'Unknown'}: ${t.text}`).join('\n');
}

function fathomToSession(m) {
  const transcript = formatTranscript(m.transcript);
  const participants = (m.calendar_invitees || []).map(i => i.name).filter(Boolean);
  const durationMs = m.recording_end_time && m.recording_start_time
    ? new Date(m.recording_end_time) - new Date(m.recording_start_time) : 0;
  return {
    id: String(m.recording_id),
    title: m.title || m.meeting_title || 'Untitled',
    date: m.recording_start_time || m.created_at,
    duration: Math.round(durationMs / 60000),
    participants,
    transcript,
    summary: m.default_summary || '',
    actionItems: m.action_items || [],
    shareUrl: m.share_url || '',
    fathomUrl: m.url || ''
  };
}

// ─── Google OAuth + Gmail API ─────────────────────────────────────────────────
function googleAuthUrl(accountHint, redirectUri) {
  const p = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline',
    prompt: 'consent',
    login_hint: accountHint || ''
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

function googleTokenRequest(params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const req = https.request({
      hostname: 'oauth2.googleapis.com', port: 443,
      path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (r.error) reject(new Error(r.error_description || r.error));
          else resolve(r);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function refreshGmailToken(email) {
  const tok = gmailTokens[email];
  if (!tok?.refreshToken) throw new Error(`No refresh token for ${email}`);
  const r = await googleTokenRequest({
    refresh_token: tok.refreshToken,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });
  gmailTokens[email] = { ...tok, accessToken: r.access_token, expiresAt: Date.now() + r.expires_in * 1000 };
  persistConfig().catch(console.error);
}

async function getGmailToken(email) {
  const tok = gmailTokens[email];
  if (!tok) throw new Error(`Gmail not connected: ${email}`);
  if (Date.now() > tok.expiresAt - 60000) await refreshGmailToken(email);
  return gmailTokens[email].accessToken;
}

function gmailGet(accessToken, endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'gmail.googleapis.com', port: 443,
      path: '/gmail/v1/users/me/' + endpoint, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + accessToken }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
}

function extractGmailBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  for (const part of (payload.parts || [])) {
    if (part.mimeType === 'text/plain' && part.body?.data)
      return Buffer.from(part.body.data, 'base64url').toString('utf-8');
    for (const nested of (part.parts || [])) {
      if (nested.mimeType === 'text/plain' && nested.body?.data)
        return Buffer.from(nested.body.data, 'base64url').toString('utf-8');
    }
  }
  return '';
}

async function fetchGmailSentEmails(email) {
  const accessToken = await getGmailToken(email);
  const listRes = await gmailGet(accessToken, 'messages?q=in%3Asent+-from%3Anoreply+-from%3Ano-reply&maxResults=100');
  const msgList = listRes.messages || [];
  console.log(`  Gmail ${email}: ${msgList.length} sent messages found`);
  const emails = [];
  for (let i = 0; i < Math.min(msgList.length, 100); i += 5) {
    const batch = msgList.slice(i, i + 5);
    const results = await Promise.all(batch.map(m => gmailGet(accessToken, `messages/${m.id}?format=full`)));
    for (const msg of results) {
      const hdrs = {};
      for (const h of (msg.payload?.headers || [])) hdrs[h.name.toLowerCase()] = h.value;
      const rawBody = extractGmailBody(msg.payload);
      // Strip quoted lines and "On ... wrote:" lines
      const bodyClean = rawBody.split('\n')
        .filter(l => !l.trim().startsWith('>') && !/^On .{10,80} wrote:/.test(l.trim()))
        .join('\n').replace(/\r/g, '').trim();
      if (bodyClean.length < 30) continue;
      emails.push({
        id: `gmail-${msg.id}`,
        subject: hdrs.subject || '(no subject)',
        to:   hdrs.to   || '',
        from: hdrs.from || email,
        date: hdrs.date || '',
        body: bodyClean.substring(0, 2000)
      });
    }
  }
  return emails;
}

// ─── Claude ───────────────────────────────────────────────────────────────────
async function callClaude(systemPrompt, userPrompt, maxTokens = 1500) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  return new Promise((resolve, reject) => {
    const messages = [{ role: 'user', content: userPrompt }];
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages
    });
    const req = https.request(
      { hostname: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST',
        headers: { 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01' } },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.content?.find(b => b.type === 'text')?.text || '');
          } catch(e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callClaudeWithHistory(systemPrompt, history, maxTokens = 1500) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: history
    });
    const req = https.request(
      { hostname: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST',
        headers: { 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01' } },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.content?.find(b => b.type === 'text')?.text || '');
          } catch(e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Deepgram STT ─────────────────────────────────────────────────────────────
async function callDeepgram(audioBuffer, contentType) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.deepgram.com',
      port: 443,
      path: '/v1/listen?model=nova-2&smart_format=true&language=en',
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': contentType || 'audio/webm',
        'Content-Length': audioBuffer.length
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const transcript = parsed.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
          resolve(transcript);
        } catch(e) { reject(new Error('Deepgram parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(audioBuffer);
    req.end();
  });
}

// ─── ElevenLabs TTS ───────────────────────────────────────────────────────────
async function callElevenLabs(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    });
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      port: 443,
      path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'audio/mpeg'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        let errData = '';
        res.on('data', c => errData += c);
        res.on('end', () => reject(new Error(`ElevenLabs ${res.statusCode}: ${errData}`)));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── RAG Search ───────────────────────────────────────────────────────────────
function scoreItem(item, query, titleField, bodyField) {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 2);
  const titleText = (item[titleField] || '').toLowerCase();
  const bodyText  = (item[bodyField]  || '').toLowerCase();
  const combined  = titleText + ' ' + bodyText;

  let score = 0;
  for (const word of words) {
    const inTitle = (titleText.match(new RegExp(word, 'g')) || []).length;
    const inBody  = (combined.match(new RegExp(word, 'g')) || []).length;
    score += inTitle * 5 + Math.min(inBody, 20);
  }

  // Recency boost: items in last 90 days get +10
  const age = Date.now() - new Date(item.date).getTime();
  if (age < 90 * 24 * 60 * 60 * 1000) score += 10;

  return score;
}

function searchSessions(sessions, query, topK = 5) {
  return sessions
    .filter(s => s.transcript)
    .map(s => ({ item: s, score: scoreItem(s, query, 'title', 'transcript') }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(r => r.score > 0)
    .map(r => r.item);
}

function searchEmails(emails, query, topK = 3) {
  return emails
    .filter(e => e.body)
    .map(e => ({ item: e, score: scoreItem(e, query, 'subject', 'body') }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(r => r.score > 0)
    .map(r => r.item);
}

function searchPodcasts(podcasts, query, topK = 3) {
  return podcasts
    .filter(p => p.body)
    .map(p => ({ item: p, score: scoreItem(p, query, 'title', 'body') }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(r => r.score > 0)
    .map(r => r.item);
}

function searchPersonal(personal, query) {
  if (!personal) return null;
  const q = query.toLowerCase();
  const personalKeywords = ['family', 'personal', 'child', 'daughter', 'son', 'school', 'home', 'car', 'insurance',
    'mortgage', 'finance', 'legal', 'lawyer', 'health', 'life', 'situation', 'challenge', 'transition',
    'wylie', 'branksome', 'piano', 'bmw', 'accident', 'aviva', 'rbc', 'appliance', 'condo'];
  const hasPersonalQuery = personalKeywords.some(kw => q.includes(kw));
  // Also match if query terms appear in the personal blob
  const blob = JSON.stringify(personal).toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 2);
  const termMatch = words.some(w => blob.includes(w));
  return (hasPersonalQuery || termMatch) ? personal : null;
}

function buildPersonalContext(personal) {
  if (!personal) return '';
  const challenges = (personal.currentChallenges || [])
    .map(c => `[${c.category.toUpperCase()}] ${c.summary}: ${c.detail.substring(0, 400)}`)
    .join('\n\n');
  const familyInfo = personal.family?.child
    ? `Child: ${personal.family.child.name} attends ${personal.family.child.school}. Activities: ${personal.family.child.activities?.join(', ')}.`
    : '';
  const style = personal.personalStyle
    ? `Under pressure: ${personal.personalStyle.underPressure}\nResilience pattern: ${personal.personalStyle.resilience}`
    : '';
  return [familyInfo, challenges, style].filter(Boolean).join('\n\n');
}

function searchWebsite(pages, query, topK = 2) {
  return pages
    .filter(p => p.body)
    .map(p => ({ item: p, score: scoreItem(p, query, 'title', 'body') }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(r => r.score > 0)
    .map(r => r.item);
}

function buildContext(sessions, maxCharsEach = 1500) {
  return sessions.map(s => {
    const excerpt = s.transcript.substring(0, maxCharsEach);
    return `--- [${s.date?.substring(0,10)}] ${s.title} (${s.duration} min) ---\nParticipants: ${s.participants.join(', ')}\n${excerpt}`;
  }).join('\n\n');
}

function buildEmailContext(emails, maxCharsEach = 1200) {
  return emails.map(e => {
    const excerpt = (e.body || '').substring(0, maxCharsEach);
    return `--- [EMAIL ${e.date?.substring(0,10)}] "${e.subject}" → ${e.to} ---\n${excerpt}`;
  }).join('\n\n');
}

function buildWebsiteContext(pages, maxCharsEach = 1500) {
  return pages.map(p => {
    const excerpt = (p.body || '').substring(0, maxCharsEach);
    return `--- [WEBSITE ${p.site}] "${p.title}" ---\n${excerpt}`;
  }).join('\n\n');
}

function buildPodcastContext(podcasts, maxCharsEach = 1200) {
  return podcasts.map(p => {
    const excerpt = (p.body || '').substring(0, maxCharsEach);
    const quotes = p.quotes ? `\nKEY QUOTES:\n${p.quotes.map(q => `"${q}"`).join('\n')}` : '';
    return `--- [PODCAST ${p.date?.substring(0,10)}] "${p.podcast}" Ep${p.episode}: "${p.title}" (guest: ${p.guest || 'solo'}, ${p.duration} min) ---\n${excerpt}${quotes}`;
  }).join('\n\n');
}

// ─── Persona Builder ──────────────────────────────────────────────────────────
async function buildPersona(sessions) {
  console.log('Building persona from transcripts + emails...');

  // Extract only Barnes's speech lines from a sample of sessions
  const barnesSpeech = sessions
    .filter(s => s.transcript)
    .slice(0, 20) // use most recent 20
    .map(s => {
      const lines = s.transcript.split('\n')
        .filter(l => l.toLowerCase().includes('barnes'))
        .slice(0, 30)
        .join('\n');
      return `[${s.title}]\n${lines}`;
    })
    .join('\n\n');

  // Include email bodies and podcast show notes as additional writing samples
  const emails = await dbLoad('emails', []);
  const podcasts = await dbLoad('podcasts', []);

  const emailSamples = emails
    .slice(0, 6)
    .map(e => `[EMAIL: ${e.subject}]\n${(e.body || '').substring(0, 350)}`)
    .join('\n\n');

  const podcastSamples = podcasts
    .slice(0, 6)
    .map(p => `[PODCAST "${p.podcast}" Ep${p.episode}: ${p.title}]\n${(p.body || '').substring(0, 300)}`)
    .join('\n\n');

  const website = await dbLoad('website', []);
  const websiteSamples = website
    .map(w => `[WEBSITE ${w.site}]\n${(w.body || '').substring(0, 600)}`)
    .join('\n\n');

  const prompt = `Analyze these transcripts, emails, podcast episodes, and website copy from Barnes Lam. Extract a detailed persona profile capturing his authentic voice, thinking style, and recurring frameworks.

MEETING TRANSCRIPTS:
${barnesSpeech.substring(0, 2500)}

WRITTEN EMAILS:
${emailSamples.substring(0, 1200)}

PODCAST EPISODES (he is the host):
${podcastSamples.substring(0, 1200)}

WEBSITE COPY (his most refined positioning):
${websiteSamples.substring(0, 1500)}

Return a JSON object with this exact structure:
{
  "communicationStyle": "2-3 sentences describing how Barnes speaks and communicates",
  "coreValues": ["value1", "value2", "value3", "value4", "value5"],
  "frameworks": ["framework or mental model 1", "framework 2", "framework 3"],
  "decisionPattern": "1-2 sentences on how Barnes approaches decisions",
  "characteristicPhrases": ["phrase1", "phrase2", "phrase3"],
  "recurringThemes": ["theme1", "theme2", "theme3", "theme4"],
  "relationshipStyle": "how Barnes engages with others",
  "builtAt": "${new Date().toISOString()}"
}

Return ONLY valid JSON.`;

  try {
    const raw = await callClaude('You are a behavioral analyst extracting communication patterns from transcripts.', prompt, 1000);
    const persona = JSON.parse(raw.replace(/```json\n?|```\n?/g, '').trim());
    await dbSave('persona', persona);
    console.log('Persona built and saved.');
    return persona;
  } catch(e) {
    console.error('Persona build failed:', e.message);
    return null;
  }
}

// ─── Memory Builder ───────────────────────────────────────────────────────────
async function buildMemory(sessions) {
  console.log('Building memory index...');

  // Topic frequency
  const topicMap = {};
  const peopleMap = {};

  for (const s of sessions) {
    for (const p of s.participants) {
      if (!p.toLowerCase().includes('barnes')) {
        peopleMap[p] = (peopleMap[p] || 0) + 1;
      }
    }
  }

  // Ask Claude to identify recurring themes across a sample
  const titlesAndDates = sessions
    .slice(0, 50)
    .map(s => `${s.date?.substring(0,10)}: ${s.title}`)
    .join('\n');

  const prompt = `Here are Barnes Lam's meeting titles over time:\n\n${titlesAndDates}\n\nIdentify:
1. The top 6 recurring topics/themes across these meetings
2. Any observable evolution in focus areas over time
3. The most important relationships (based on recurring people/meeting types)

Return JSON:
{
  "topTopics": [{"topic": "name", "frequency": "high/medium/low", "description": "1 sentence"}],
  "thinkingEvolution": "2-3 sentences on how Barnes's focus has shifted over time",
  "keyRelationships": [{"name": "meeting type or person", "context": "what it's about"}],
  "lastUpdated": "${new Date().toISOString()}"
}

Return ONLY valid JSON.`;

  try {
    const raw = await callClaude('You are analyzing meeting patterns for a personal knowledge system.', prompt, 800);
    const memory = JSON.parse(raw.replace(/```json\n?|```\n?/g, '').trim());
    memory.topPeople = Object.entries(peopleMap)
      .sort((a,b) => b[1]-a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, meetingCount: count }));
    memory.totalSessions = sessions.length;
    memory.withTranscript = sessions.filter(s => s.transcript).length;
    await dbSave('memory', memory);
    console.log('Memory built and saved.');
    return memory;
  } catch(e) {
    console.error('Memory build failed:', e.message);
    return null;
  }
}

// ─── System Prompt Builder ────────────────────────────────────────────────────
async function getSystemPrompt() {
  const [persona, personal] = await Promise.all([
    dbLoad('persona', null),
    dbLoad('personal', null)
  ]);

  let base = `You are Barnes Lam — responding based on your actual recorded sessions and thinking. You speak in first person as Barnes.

Be direct, practical, and grounded. Draw on real patterns from the transcripts provided. Don't be generic.`;

  if (persona) {
    base += `

YOUR COMMUNICATION STYLE: ${persona.communicationStyle}
YOUR CORE VALUES: ${persona.coreValues?.join(', ')}
YOUR FRAMEWORKS: ${persona.frameworks?.join(', ')}
HOW YOU MAKE DECISIONS: ${persona.decisionPattern}
YOUR CHARACTERISTIC PHRASES: ${persona.characteristicPhrases?.join(', ')}`;
  }

  if (personal) {
    const child = personal.family?.child;
    const challenges = (personal.currentChallenges || []).map(c => `${c.category}: ${c.summary}`).join('; ');
    base += `

YOUR PERSONAL LIFE CONTEXT (as of early 2026):
- Home: ${personal.residences?.primary || 'Toronto'}
- Family: ${child ? `Child ${child.name} attends ${child.school}` : ''}
- Current challenges: ${challenges}
- Personal style under pressure: ${personal.personalStyle?.underPressure?.substring(0, 200) || ''}`;
  }

  return base;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Extract from Fathom + rebuild persona + memory
// Legacy endpoint — kept for backwards compat
app.post('/api/extract', async (req, res) => {
  req.url = '/api/sync-all';
  return syncAll(req, res);
});

// Find New Data — merge-safe sync across all connected sources
async function syncAll(req, res) {
  try {
    // ── Fathom sessions (merge with existing to preserve data) ────────────────
    console.log('Syncing Fathom sessions...');
    const raw = await fetchAllFathomMeetings();
    const incoming = raw.map(fathomToSession);
    const existing = await dbLoad('sessions', []);
    const existingMap = Object.fromEntries(existing.map(s => [s.id, s]));
    const beforeCount = Object.keys(existingMap).length;
    for (const s of incoming) {
      existingMap[s.id] = { ...(existingMap[s.id] || {}), ...s };
    }
    const merged = Object.values(existingMap);
    const newCount = merged.length - beforeCount;
    await dbSave('sessions', merged);
    console.log(`Sessions: ${merged.length} total (${newCount} new)`);

    // ── Gmail sync for each connected account ─────────────────────────────────
    let existingEmails = await dbLoad('emails', []);
    const existingEmailIds = new Set(existingEmails.map(e => e.id));
    let newEmailCount = 0;
    const gmailErrors = [];
    for (const gmailAccount of Object.keys(gmailTokens)) {
      try {
        console.log(`Syncing Gmail: ${gmailAccount}...`);
        const pulled = await fetchGmailSentEmails(gmailAccount);
        const fresh = pulled.filter(e => !existingEmailIds.has(e.id));
        if (fresh.length) {
          existingEmails = [...existingEmails, ...fresh];
          for (const e of fresh) existingEmailIds.add(e.id);
          newEmailCount += fresh.length;
          console.log(`  Gmail ${gmailAccount}: ${fresh.length} new emails`);
        }
      } catch(e) {
        console.error(`Gmail sync error (${gmailAccount}):`, e.message);
        gmailErrors.push(`${gmailAccount}: ${e.message}`);
      }
    }
    if (newEmailCount > 0) await dbSave('emails', existingEmails);

    // ── Load counts from all other sources ────────────────────────────────────
    const [podcasts, website] = await Promise.all([
      dbLoad('podcasts', []),
      dbLoad('website', [])
    ]);

    // Build persona + memory in background
    buildPersona(merged).catch(console.error);
    buildMemory(merged).catch(console.error);

    res.json({
      success: true,
      sessions:  { total: merged.length, newCount, withTranscript: merged.filter(s => s.transcript).length },
      emails:    existingEmails.length,
      newEmails: newEmailCount,
      podcasts:  podcasts.length,
      website:   website.length,
      gmailAccounts: Object.keys(gmailTokens),
      ...(gmailErrors.length && { gmailErrors }),
      message: 'Sync complete. Persona and memory rebuilding in background.'
    });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
}
app.post('/api/sync-all', syncAll);

// Explicitly rebuild persona
app.post('/api/build-persona', async (req, res) => {
  try {
    const sessions = await dbLoad('sessions', []);
    if (!sessions.length) return res.status(400).json({ success: false, error: 'No sessions. Extract first.' });
    const persona = await buildPersona(sessions);
    const memory  = await buildMemory(sessions);
    res.json({ success: true, persona, memory });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get persona
app.get('/api/persona', async (req, res) => {
  const persona = await dbLoad('persona', null);
  res.json({ success: true, persona });
});

// Get memory
app.get('/api/memory', async (req, res) => {
  const memory = await dbLoad('memory', null);
  res.json({ success: true, memory });
});

// Config — get (masked) and set API keys at runtime
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    anthropicApiKey:    ANTHROPIC_API_KEY   ? '••••' + ANTHROPIC_API_KEY.slice(-4)   : '',
    elevenLabsApiKey:   ELEVENLABS_API_KEY  ? '••••' + ELEVENLABS_API_KEY.slice(-4)  : '',
    elevenLabsVoiceId:  ELEVENLABS_VOICE_ID,
    anthropicSet:       !!ANTHROPIC_API_KEY,
    elevenLabsSet:      !!ELEVENLABS_API_KEY,
    googleClientId:     GOOGLE_CLIENT_ID    ? '••••' + GOOGLE_CLIENT_ID.slice(-6)    : '',
    googleConfigured:   !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    gmailAccounts:      Object.keys(gmailTokens),
  });
});

app.post('/api/config', async (req, res) => {
  const { anthropicApiKey, elevenLabsApiKey, elevenLabsVoiceId, googleClientId, googleClientSecret } = req.body;
  if (anthropicApiKey    !== undefined) ANTHROPIC_API_KEY    = anthropicApiKey;
  if (elevenLabsApiKey   !== undefined) ELEVENLABS_API_KEY   = elevenLabsApiKey;
  if (elevenLabsVoiceId  !== undefined) ELEVENLABS_VOICE_ID  = elevenLabsVoiceId;
  if (googleClientId     !== undefined) GOOGLE_CLIENT_ID     = googleClientId;
  if (googleClientSecret !== undefined) GOOGLE_CLIENT_SECRET = googleClientSecret;
  await persistConfig();
  res.json({ success: true, anthropicSet: !!ANTHROPIC_API_KEY, elevenLabsSet: !!ELEVENLABS_API_KEY, googleConfigured: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) });
});

// ── Gmail OAuth endpoints ─────────────────────────────────────────────────────
app.get('/api/gmail/auth', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET)
    return res.status(400).send('Google credentials not configured. Add them in Settings first.');
  const account = req.query.account || '';
  const redirectUri = `${req.protocol}://${req.get('host')}/api/gmail/callback`;
  res.redirect(googleAuthUrl(account, redirectUri));
});

app.get('/api/gmail/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('<h2>Error: no authorization code received.</h2>');
  const redirectUri = `${req.protocol}://${req.get('host')}/api/gmail/callback`;
  try {
    const tokens = await googleTokenRequest({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });
    // Get email address from Google
    const profile = await gmailGet(tokens.access_token, 'profile');
    const email = profile.emailAddress;
    gmailTokens[email] = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000
    };
    await persistConfig();
    console.log(`Gmail connected: ${email}`);
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:48px;text-align:center">
      <h2 style="color:#34d399">Connected: ${email}</h2>
      <p style="color:#94a3b8">Gmail sync is now active. You can close this window.</p>
      <script>if(window.opener){window.opener.postMessage({type:'gmail-connected',email:'${email}'},'*');setTimeout(()=>window.close(),1500);}</script>
    </body></html>`);
  } catch(e) {
    console.error('Gmail OAuth error:', e.message);
    res.send(`<h2 style="color:red">Error: ${e.message}</h2>`);
  }
});

app.get('/api/gmail/status', (req, res) => {
  res.json({ success: true, accounts: Object.keys(gmailTokens), googleConfigured: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) });
});

app.delete('/api/gmail/disconnect', async (req, res) => {
  const { account } = req.query;
  if (account && gmailTokens[account]) { delete gmailTokens[account]; await persistConfig(); }
  res.json({ success: true, accounts: Object.keys(gmailTokens) });
});

// Stats
app.get('/api/stats', async (req, res) => {
  try {
    const [sessions, emails, podcasts, website, persona, memory, personal] = await Promise.all([
      dbLoad('sessions', []), dbLoad('emails', []), dbLoad('podcasts', []),
      dbLoad('website', []), dbLoad('persona', null), dbLoad('memory', null), dbLoad('personal', null)
    ]);
    res.json({
      success: true,
      videoCount: sessions.length,
      transcriptCount: sessions.filter(s => s.transcript).length,
      emailCount: emails.length,
      podcastCount: podcasts.length,
      websiteCount: website.length,
      personaBuilt: !!persona,
      memoryBuilt: !!memory,
      personalLoaded: !!personal,
      kbActive: sessions.length > 0
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Search transcripts + emails
app.post('/api/search', async (req, res) => {
  const { query, topK = 5 } = req.body;
  if (!query) return res.status(400).json({ success: false, error: 'query required' });
  const [sessions, emails, podcasts, website] = await Promise.all([
    dbLoad('sessions', []), dbLoad('emails', []), dbLoad('podcasts', []), dbLoad('website', [])
  ]);
  const sessionResults = searchSessions(sessions, query, topK).map(s => ({
    type: 'session', id: s.id, title: s.title, date: s.date, duration: s.duration,
    participants: s.participants,
    excerpt: s.transcript.substring(0, 300) + '...'
  }));
  const emailResults = searchEmails(emails, query, 3).map(e => ({
    type: 'email', id: e.id, title: e.subject, date: e.date,
    to: e.to, excerpt: (e.body || '').substring(0, 300) + '...'
  }));
  const podcastResults = searchPodcasts(podcasts, query, 3).map(p => ({
    type: 'podcast', id: p.id, title: `${p.podcast} Ep${p.episode}: ${p.title}`, date: p.date,
    guest: p.guest, excerpt: (p.body || '').substring(0, 300) + '...'
  }));
  const websiteResults = searchWebsite(website, query, 2).map(w => ({
    type: 'website', id: w.id, title: w.title, date: w.date,
    site: w.site, excerpt: (w.body || '').substring(0, 300) + '...'
  }));
  const results = [...sessionResults, ...emailResults, ...podcastResults, ...websiteResults];
  res.json({ success: true, count: results.length, results });
});

// Get all sessions (lightweight list)
app.get('/api/sessions', async (req, res) => {
  const sessions = await dbLoad('sessions', []);
  res.json({
    success: true, count: sessions.length,
    sessions: sessions.map(s => ({
      id: s.id, title: s.title, date: s.date, duration: s.duration,
      participants: s.participants, hasTranscript: !!s.transcript
    }))
  });
});

// Chat — main Q&A with RAG + persona + conversation history
app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'message required' });

  try {
    const [sessions, emails, podcasts, website, personal] = await Promise.all([
      dbLoad('sessions', []), dbLoad('emails', []), dbLoad('podcasts', []), dbLoad('website', []), dbLoad('personal', null)
    ]);
    if (!sessions.length && !emails.length && !podcasts.length && !website.length) {
      return res.status(400).json({ success: false, error: 'No knowledge base. Run /api/extract first.' });
    }

    // Find relevant content across all sources
    const relevantSessions = searchSessions(sessions, message, 3);
    const relevantEmails   = searchEmails(emails, message, 2);
    const relevantPodcasts = searchPodcasts(podcasts, message, 2);
    const relevantWebsite  = searchWebsite(website, message, 1);
    const relevantPersonal = searchPersonal(personal, message);
    const sessionContext   = buildContext(relevantSessions);
    const emailContext     = buildEmailContext(relevantEmails);
    const podcastContext   = buildPodcastContext(relevantPodcasts);
    const websiteContext   = buildWebsiteContext(relevantWebsite);
    const personalContext  = buildPersonalContext(relevantPersonal);

    const contextParts = [];
    if (websiteContext)  contextParts.push(`YOUR POSITIONING (website copy — most refined thinking):\n${websiteContext}`);
    if (sessionContext)  contextParts.push(`RELEVANT MEETING TRANSCRIPTS:\n${sessionContext}`);
    if (emailContext)    contextParts.push(`RELEVANT EMAILS YOU WROTE:\n${emailContext}`);
    if (podcastContext)  contextParts.push(`RELEVANT PODCAST EPISODES YOU HOSTED:\n${podcastContext}`);
    if (personalContext) contextParts.push(`YOUR PERSONAL LIFE CONTEXT:\n${personalContext}`);
    const fullContext = contextParts.join('\n\n') || 'No closely matching content found — answer from your general patterns.';

    const systemPrompt = await getSystemPrompt();
    const fullSystem = `${systemPrompt}

${fullContext}

Answer as Barnes Lam. Be specific and direct. Reference meeting titles, email subjects, or podcast episode titles when drawing from them.`;

    // Build message history
    const messages = [
      ...history.slice(-6), // last 3 exchanges for context
      { role: 'user', content: message }
    ];

    const answer = await callClaudeWithHistory(fullSystem, messages, 1200);

    const sources = [
      ...relevantWebsite.map(w => ({
        type: 'website', title: w.site, date: w.date?.substring(0, 10)
      })),
      ...relevantSessions.map(s => ({
        type: 'session', title: s.title, date: s.date?.substring(0, 10), duration: s.duration
      })),
      ...relevantEmails.map(e => ({
        type: 'email', title: e.subject, date: e.date?.substring(0, 10), to: e.to
      })),
      ...relevantPodcasts.map(p => ({
        type: 'podcast', title: `Ep${p.episode}: ${p.title}`, date: p.date?.substring(0, 10), podcast: p.podcast
      }))
    ];

    res.json({ success: true, answer, sources });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Legacy /api/ask (backwards compat)
app.post('/api/ask', async (req, res) => {
  req.body.message = req.body.question;
  const next = (err) => { if(err) res.status(500).json({ success: false, error: err.message }); };
  const fakeRes = {
    status: (code) => ({ json: (data) => res.status(code).json(data) }),
    json: (data) => res.json({ ...data, answer: data.answer })
  };
  req.body.message = req.body.question;
  // just forward to chat handler logic inline
  try {
    const sessions = await dbLoad('sessions', []);
    const relevant = searchSessions(sessions, req.body.question, 5);
    const context  = buildContext(relevant);
    const systemPrompt = await getSystemPrompt();
    const fullSystem = `${systemPrompt}\n\nRELEVANT TRANSCRIPTS:\n${context}`;
    const answer = await callClaude(fullSystem, req.body.question, 1000);
    res.json({ success: true, question: req.body.question, answer, sources: relevant.map(s => s.title) });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Add emails to knowledge base (dedupe by id)
// Accepts: { emails: [{id, subject, from, to, date, body}] }
// Works with any email source — Barnes can use Claude Code + Gmail MCP to pull
// emails from any address and POST them here.
app.post('/api/emails/add', async (req, res) => {
  const { emails: incoming } = req.body;
  if (!Array.isArray(incoming) || !incoming.length) {
    return res.status(400).json({ success: false, error: 'emails array required' });
  }
  try {
    const existing = await dbLoad('emails', []);
    const existingIds = new Set(existing.map(e => e.id));
    const newEmails = incoming.filter(e => e.id && !existingIds.has(e.id));
    if (!newEmails.length) {
      return res.json({ success: true, added: 0, total: existing.length, message: 'All emails already in knowledge base' });
    }
    const merged = [...existing, ...newEmails];
    await dbSave('emails', merged);
    console.log(`Added ${newEmails.length} new emails (total: ${merged.length})`);
    res.json({ success: true, added: newEmails.length, total: merged.length });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Transcribe audio → text via Deepgram
app.post('/api/transcribe', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  try {
    if (!DEEPGRAM_API_KEY) return res.status(501).json({ success: false, error: 'DEEPGRAM_API_KEY not configured' });
    const contentType = req.headers['content-type'] || 'audio/webm';
    const transcript = await callDeepgram(req.body, contentType);
    res.json({ success: true, transcript });
  } catch(e) {
    console.error('Transcribe error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Text → audio via ElevenLabs TTS
app.post('/api/speak', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ success: false, error: 'text required' });
  if (!ELEVENLABS_API_KEY) return res.status(501).json({ success: false, error: 'ELEVENLABS_API_KEY not configured — add it to your .env' });
  try {
    const audio = await callElevenLabs(text);
    res.set('Content-Type', 'audio/mpeg');
    res.send(audio);
  } catch(e) {
    console.error('Speak error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Start
async function start() {
  await initDataDir();
  app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║     Barnes Lam Personal AI — v2            ║
╚════════════════════════════════════════════╝

  http://localhost:${PORT}

  POST /api/extract        Pull all Fathom sessions
  POST /api/build-persona  Rebuild persona + memory from transcripts
  GET  /api/persona        View current persona
  GET  /api/memory         View memory + insights
  POST /api/chat           Chat (RAG + persona + history)
  POST /api/search         Search transcripts
  GET  /api/stats          System stats
    `);

    // ── Auto-sync every 4 hours ───────────────────────────────────────────────
    const FOUR_HOURS = 4 * 60 * 60 * 1000;
    setInterval(() => {
      console.log(`[auto-sync] Running scheduled sync at ${new Date().toISOString()}`);
      syncAll({ httpMethod: 'POST' }, {
        json: (data) => console.log(`[auto-sync] Done:`, JSON.stringify(data)),
        status: () => ({ json: (d) => console.error('[auto-sync] Error:', d) })
      }).catch(e => console.error('[auto-sync] Failed:', e.message));
    }, FOUR_HOURS);
    console.log(`[auto-sync] Scheduled every 4 hours`);
  });
}

start();
