#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://qiwdgyilhwkndqkgqruf.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFpd2RneWlsaHdrbmRxa2dxcnVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTc4NDcsImV4cCI6MjA5MTY3Mzg0N30.bEhiitzcDMOpViFFtBhfbUKcHVDah8t7DvsNlTxaOEk';
const DATA = path.join(__dirname, 'data');

function supaPost(table, rows, extra = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(rows);
    const req = https.request({
      hostname: 'qiwdgyilhwkndqkgqruf.supabase.co', port: 443,
      path: `/rest/v1/${table}`,
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'Prefer': 'resolution=merge-duplicates,return=minimal', ...extra
      }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function upsertBatch(table, rows, batchSize = 50) {
  let done = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { status } = await supaPost(table, batch);
    if (status >= 400) { console.error(`  ✗ Batch ${i}–${i+batchSize} failed (HTTP ${status})`); }
    else { done += batch.length; process.stdout.write(`\r  ✓ ${done}/${rows.length}`); }
  }
  console.log('');
}

function load(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf-8')); }
  catch { return null; }
}

async function main() {
  console.log('Barnes LLM → Supabase migration\n');

  // ── Sessions ────────────────────────────────────────────────────────────────
  const sessions = load('sessions.json');
  if (sessions?.length) {
    console.log(`Migrating ${sessions.length} sessions...`);
    const rows = sessions.map(s => ({
      id: String(s.id),
      title: s.title || 'Untitled',
      date: s.date || null,
      duration: s.duration || 0,
      participants: s.participants || [],
      transcript: s.transcript || '',
      summary: s.summary || '',
      action_items: s.actionItems || [],
      share_url: s.shareUrl || '',
      fathom_url: s.fathomUrl || ''
    }));
    await upsertBatch('bl_sessions', rows);
    console.log(`  → ${sessions.length} sessions done\n`);
  } else {
    console.log('No sessions found locally.\n');
  }

  // ── Emails ──────────────────────────────────────────────────────────────────
  const emails = load('emails.json');
  if (emails?.length) {
    console.log(`Migrating ${emails.length} emails...`);
    const rows = emails.map((e, i) => ({
      id: String(e.id || e.messageId || `email-${i}`),
      subject: e.subject || '',
      to_addr: e.to || '',
      from_addr: e.from || '',
      date: e.date || null,
      body: e.body || ''
    }));
    await upsertBatch('bl_emails', rows, 20);
    console.log(`  → ${emails.length} emails done\n`);
  }

  // ── Persona ─────────────────────────────────────────────────────────────────
  const persona = load('persona.json');
  if (persona) {
    console.log('Migrating persona...');
    const { status } = await supaPost('bl_persona', [{ id: 1, data: persona, built_at: persona.builtAt || new Date().toISOString() }]);
    console.log(status < 400 ? '  → Persona done\n' : `  ✗ Persona failed (HTTP ${status})\n`);
  }

  // ── Memory ───────────────────────────────────────────────────────────────────
  const memory = load('memory.json');
  if (memory) {
    console.log('Migrating memory...');
    const { status } = await supaPost('bl_memory', [{ id: 1, data: memory, updated_at: memory.lastUpdated || new Date().toISOString() }]);
    console.log(status < 400 ? '  → Memory done\n' : `  ✗ Memory failed (HTTP ${status})\n`);
  }

  console.log('Migration complete. App will load instantly with all data.');
}

main().catch(console.error);
