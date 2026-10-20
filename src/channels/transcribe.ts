/**
 * Voice-note transcription for chat-sdk bridges.
 *
 * Agent containers have no ffmpeg or speech model, so an audio attachment
 * reaches them as an opaque file. The bridge transcribes it on the host and
 * appends the text to the message body, so every agent gets words instead.
 *
 * The backend is a whisper.cpp `whisper-server` (started with `--convert`, so
 * it accepts ogg/opus, m4a, and anything else ffmpeg reads).
 */
import { log } from '../log.js';

/** Turns raw audio bytes into text. Returns null when there is nothing usable. */
export type AudioTranscriber = (data: Buffer, att: { name?: string; mimeType?: string }) => Promise<string | null>;

const DEFAULT_TIMEOUT_MS = 120_000;

/** Transcriber backed by a whisper.cpp server's `/inference` endpoint. */
export function createWhisperTranscriber(baseUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): AudioTranscriber {
  const url = `${baseUrl.replace(/\/+$/, '')}/inference`;
  return async (data, att) => {
    const form = new FormData();
    form.append('file', new Blob([data], { type: att.mimeType ?? 'application/octet-stream' }), att.name ?? 'audio');
    form.append('response_format', 'json');
    const started = Date.now();
    const res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`whisper-server ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
    log.info('Transcribed audio attachment', { name: att.name, bytes: data.length, ms: Date.now() - started });
    return text || null;
  };
}

/**
 * Append a transcript to the serialized body, labelled with the attachment
 * name so several notes in one message stay distinguishable.
 */
export function appendTranscript(
  serialized: Record<string, unknown>,
  name: string | undefined,
  transcript: string,
): void {
  const label = name ? `[Voice note transcript: ${name}]` : '[Voice note transcript]';
  const extra = `${label}\n${transcript}`;
  const text = typeof serialized.text === 'string' ? serialized.text : '';
  serialized.text = text ? `${text}\n\n${extra}` : extra;
}
