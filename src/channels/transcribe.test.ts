/**
 * Voice-note transcription.
 *
 * The transcriber talks to a whisper.cpp server, stubbed here with a local
 * HTTP server. appendTranscript must keep the original body (Matrix puts the
 * file name there) and add one labelled block per note.
 */
import http from 'http';
import type { AddressInfo } from 'net';

import { afterEach, describe, expect, it } from 'vitest';

import { appendTranscript, createWhisperTranscriber } from './transcribe.js';

describe('appendTranscript', () => {
  it('appends a labelled block after the existing body', () => {
    const serialized: Record<string, unknown> = { text: 'voice-note.ogg' };
    appendTranscript(serialized, 'voice-note.ogg', 'hello there');
    expect(serialized.text).toBe('voice-note.ogg\n\n[Voice note transcript: voice-note.ogg]\nhello there');
  });

  it('uses the block alone when the message had no body', () => {
    const serialized: Record<string, unknown> = {};
    appendTranscript(serialized, undefined, 'hello');
    expect(serialized.text).toBe('[Voice note transcript]\nhello');
  });
});

describe('createWhisperTranscriber', () => {
  let server: http.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function serve(
    status: number,
    body: string,
  ): Promise<{ url: string; requests: { path?: string; body: string }[] }> {
    const requests: { path?: string; body: string }[] = [];
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        requests.push({ path: req.url, body: data });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`, requests };
  }

  it('posts the audio to /inference and returns the collapsed text', async () => {
    const { url, requests } = await serve(200, JSON.stringify({ text: ' As a quick test,\n can you hear me?\n' }));
    const transcribe = createWhisperTranscriber(url);
    const text = await transcribe(Buffer.from('OggS'), { name: 'voice-note.ogg', mimeType: 'audio/ogg' });
    expect(text).toBe('As a quick test, can you hear me?');
    expect(requests[0].path).toBe('/inference');
    expect(requests[0].body).toContain('filename="voice-note.ogg"');
    expect(requests[0].body).toContain('response_format');
  });

  it('returns null for an empty transcript', async () => {
    const { url } = await serve(200, JSON.stringify({ text: '  \n' }));
    expect(await createWhisperTranscriber(url)(Buffer.from('x'), {})).toBeNull();
  });

  it('throws on a server error so the bridge can log it', async () => {
    const { url } = await serve(500, '{"error":"bad audio"}');
    await expect(createWhisperTranscriber(url)(Buffer.from('x'), {})).rejects.toThrow('whisper-server 500');
  });
});
