/**
 * Outbound files carry a MIME type guessed from the filename, so adapters can
 * send images as images (Matrix `m.image`) rather than generic attachments.
 */
import { describe, expect, it } from 'vitest';

import { mimeTypeForFilename } from './chat-sdk-bridge.js';

describe('mimeTypeForFilename', () => {
  it('maps image, video and audio extensions', () => {
    expect(mimeTypeForFilename('desktop-light.png')).toBe('image/png');
    expect(mimeTypeForFilename('photo.JPG')).toBe('image/jpeg');
    expect(mimeTypeForFilename('clip.mp4')).toBe('video/mp4');
    expect(mimeTypeForFilename('note.m4a')).toBe('audio/mp4');
  });

  it('uses the last extension only', () => {
    expect(mimeTypeForFilename('archive.tar.zip')).toBe('application/zip');
  });

  it('returns undefined for unknown or missing extensions', () => {
    expect(mimeTypeForFilename('Makefile')).toBeUndefined();
    expect(mimeTypeForFilename('data.xyz')).toBeUndefined();
  });
});
