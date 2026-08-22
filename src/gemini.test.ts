import { describe, it, expect } from 'vitest';
import { ProxyError, isPermanentFailure, isRateLimitFailure } from './gemini';

/**
 * These predicates decide whether a failed AI call becomes a queued retry or an
 * honest message. Before they existed every failure looked alike, so a quota
 * rejection was queued and reported to the student as being offline.
 */

describe('ProxyError', () => {

  it('carries the status the proxy answered with', () => {
    const err = new ProxyError('Too many requests.', 429);
    expect(err.status).toBe(429);
    expect(err.message).toBe('Too many requests.');
  });

  it('is a real Error, so existing catch blocks still work', () => {
    const err = new ProxyError('nope', 400);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ProxyError');
  });
});

describe('isPermanentFailure', () => {

  it.each([400, 403, 404, 413, 429, 499])('treats %i as permanent', (status) => {
    // A 4xx means the request itself was refused; all three retries would be
    // spent re-sending something already turned down.
    expect(isPermanentFailure(new ProxyError('refused', status))).toBe(true);
  });

  it.each([500, 502, 503, 504])('treats %i as transient, so it gets queued', (status) => {
    expect(isPermanentFailure(new ProxyError('upstream', status))).toBe(false);
  });

  it('treats a plain network error as transient', () => {
    // fetch rejecting with no reply is exactly what the sync queue is for.
    expect(isPermanentFailure(new TypeError('Failed to fetch'))).toBe(false);
  });

  it.each([null, undefined, 'a string', 429])('is false for the non-error %p', (v) => {
    expect(isPermanentFailure(v)).toBe(false);
  });
});

describe('isRateLimitFailure', () => {

  it('is true only for 429', () => {
    expect(isRateLimitFailure(new ProxyError('slow down', 429))).toBe(true);
  });

  it.each([400, 403, 500, 503])('is false for %i', (status) => {
    expect(isRateLimitFailure(new ProxyError('other', status))).toBe(false);
  });

  it('is false for a network error', () => {
    expect(isRateLimitFailure(new TypeError('Failed to fetch'))).toBe(false);
  });
});
