import { describe, it, expect } from 'vitest';
import { renderEmail } from './email-layout.js';

const CONTENT = {
  appName: 'Ecom',
  heading: 'Xác thực địa chỉ email của bạn',
  paragraphs: ['Dùng mã dưới đây để hoàn tất đăng ký.'],
  highlight: '482915',
  afterParagraphs: ['Mã có hiệu lực trong 10 phút.'],
  reason: 'Bạn nhận email này vì đã đăng ký tại Ecom.',
};

describe('renderEmail', () => {
  it('puts the shop name, heading, paragraphs, highlighted value and footer in both versions', () => {
    const { html, text } = renderEmail(CONTENT);

    for (const part of [
      'Ecom',
      CONTENT.heading,
      CONTENT.paragraphs[0],
      '482915',
      CONTENT.afterParagraphs[0],
      CONTENT.reason,
    ]) {
      expect(html).toContain(part);
      expect(text).toContain(part);
    }
  });

  it('produces a complete HTML document a mail client can render', () => {
    const { html } = renderEmail(CONTENT);

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="vi">');
    expect(html).toContain('charset="utf-8"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('</html>');
  });

  it('escapes everything it was given, so markup in a value cannot change the page', () => {
    const { html, text } = renderEmail({
      ...CONTENT,
      appName: '<b>Shop & Co</b>',
      paragraphs: ['<script>alert("x")</script>'],
      highlight: '<img src=x>',
      reason: "it's <i>fine</i>",
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('<b>Shop');
    expect(html).toContain('&lt;b&gt;Shop &amp; Co&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('it&#39;s &lt;i&gt;fine&lt;/i&gt;');
    // the plain-text version has no markup to escape, so it keeps the raw text
    expect(text).toContain('<b>Shop & Co</b>');
  });

  it('works without a highlighted value or trailing paragraphs', () => {
    const { html, text } = renderEmail({
      appName: 'Ecom',
      heading: 'Hello',
      paragraphs: ['Just a note.'],
      reason: 'Because.',
    });

    expect(html).toContain('Just a note.');
    expect(html).not.toContain('letter-spacing');
    expect(text).toBe(
      ['Ecom', '', 'Hello', '', 'Just a note.', '', '--', 'Because.'].join(
        '\n',
      ),
    );
  });

  it('writes the plain-text version readable on its own, with the footer set apart', () => {
    const { text } = renderEmail(CONTENT);

    expect(text.startsWith('Ecom\n\n' + CONTENT.heading)).toBe(true);
    expect(text).toContain('    482915');
    expect(text.endsWith(`--\n${CONTENT.reason}`)).toBe(true);
  });
});
