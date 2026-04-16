'use strict';
const { err, preflight, callElevenLabs, ELEVENLABS_KEY, CORS } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  try {
    const { text } = JSON.parse(event.body || '{}');
    if (!text) return err('text required', 400);
    if (!ELEVENLABS_KEY) return err('ELEVENLABS_API_KEY not configured — add it to Netlify env vars', 501);

    const audio = await callElevenLabs(text);
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'audio/mpeg' },
      body: audio.toString('base64'),
      isBase64Encoded: true
    };
  } catch(e) { return err(e.message); }
};
