import { describe, it, expect } from 'vitest';
import { escapeHtml } from './escape';

/**
 * These assert against the DOM rather than against expected strings.
 *
 * Comparing output to a hand-written entity string only proves the function does
 * what it currently does. Interpolating into innerHTML and asking the parser what
 * it built proves the thing that actually matters: no element was created and no
 * handler was attached.
 */
function renderInterpolated(value: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = `<p class="out">${escapeHtml(value)}</p>`;
  return host;
}

describe('escapeHtml', () => {

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('Introduction to Fractions')).toBe('Introduction to Fractions');
  });

  it('escapes & first, so entities are not double-escaped', () => {
    // If & ran after <, the &lt; it produced would become &amp;lt; and render literally.
    expect(escapeHtml('a < b & c')).toBe('a &lt; b &amp; c');
  });

  it('renders a script payload as text, not an element', () => {
    const host = renderInterpolated('<script>alert(1)</script>');
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('.out')?.textContent).toBe('<script>alert(1)</script>');
  });

  it('renders an img/onerror payload as text, not an element', () => {
    const host = renderInterpolated('<img src=x onerror=alert(1)>');
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.out')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('cannot break out of a quoted attribute', () => {
    // The nickname reaches at least one attribute position, so a payload that
    // closes the quote and adds a handler has to stay inert.
    const host = document.createElement('div');
    host.innerHTML = `<div data-nick="${escapeHtml('" onmouseover="alert(1)')}"></div>`;
    const target = host.querySelector('div');
    expect(target?.getAttribute('onmouseover')).toBeNull();
    expect(target?.getAttribute('data-nick')).toBe('" onmouseover="alert(1)');
  });

  it('neutralises a payload that closes the surrounding tag', () => {
    const host = renderInterpolated('"><script>alert(1)</script>');
    expect(host.querySelectorAll('*')).toHaveLength(1); // just the <p>
    expect(host.querySelector('script')).toBeNull();
  });

  it('handles a malformed model response the same as a hostile one', () => {
    // The realistic case is not an attacker — it is Gemini emitting stray markup
    // in a lesson title. It has to be inert for the same reason.
    const host = renderInterpolated('Fractions <b>and</b> Decimals');
    expect(host.querySelector('b')).toBeNull();
    expect(host.querySelector('.out')?.textContent).toBe('Fractions <b>and</b> Decimals');
  });

  it('is idempotent in the sense that escaping twice is visible, not silent', () => {
    // Guards against someone "helpfully" adding a second escape pass later.
    expect(escapeHtml(escapeHtml('<b>'))).toBe('&amp;lt;b&amp;gt;');
  });
});
