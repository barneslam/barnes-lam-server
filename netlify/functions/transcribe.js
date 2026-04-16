'use strict';
const { ok, err, preflight, callDeepgram } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  try {
    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || 'audio/webm';
    const audioBuffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'binary');
    if (!audioBuffer.length) return err('No audio data received', 400);
    const transcript = await callDeepgram(audioBuffer, contentType);
    return ok({ success: true, transcript });
  } catch(e) { return err(e.message); }
};
