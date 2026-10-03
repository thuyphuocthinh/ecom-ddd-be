export interface EmailLayoutContent {
  /** The shop's name, shown at the top and used in the footer. */
  appName: string;
  heading: string;
  /** Paragraphs before the highlighted value. */
  paragraphs: string[];
  /** A value the reader has to copy (e.g. a one-time code), shown large on its own line. */
  highlight?: string;
  /** Paragraphs after the highlighted value. */
  afterParagraphs?: string[];
  /** Why the reader got this email, shown in the footer. */
  reason: string;
}

export interface RenderedEmail {
  html: string;
  text: string;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const FONT = 'Arial, Helvetica, sans-serif';

/**
 * The one look every email shares: the shop's name on top, the content, and a footer
 * saying why it was sent. Each kind of email only supplies its words; the HTML (inline
 * styles and tables, because mail clients ignore most of modern CSS) and the plain-text
 * twin both come from here, so they can't drift apart. All text is escaped, so a value
 * with markup in it can't change the page.
 */
export function renderEmail(content: EmailLayoutContent): RenderedEmail {
  const { appName, heading, paragraphs, highlight, afterParagraphs, reason } =
    content;
  const after = afterParagraphs ?? [];

  const paragraph = (value: string) =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${escapeHtml(value)}</p>`;

  const highlightBlock = highlight
    ? `<div style="margin:8px 0 24px;padding:16px;background:#f3f4f6;border-radius:6px;text-align:center;font-size:32px;font-weight:bold;letter-spacing:8px;color:#111827;">${escapeHtml(highlight)}</div>`
    : '';

  const html = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5f7;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="480" cellspacing="0" cellpadding="0" style="width:100%;max-width:480px;background:#ffffff;border-radius:8px;">
<tr><td style="padding:32px;font-family:${FONT};">
<div style="margin:0 0 24px;font-size:18px;font-weight:bold;color:#111827;">${escapeHtml(appName)}</div>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#111827;">${escapeHtml(heading)}</h1>
${paragraphs.map(paragraph).join('\n')}
${highlightBlock}
${after.map(paragraph).join('\n')}
<hr style="margin:24px 0 16px;border:0;border-top:1px solid #e5e7eb;">
<p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280;">${escapeHtml(reason)}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    appName,
    '',
    heading,
    '',
    ...paragraphs.flatMap((value) => [value, '']),
    ...(highlight ? [`    ${highlight}`, ''] : []),
    ...after.flatMap((value) => [value, '']),
    '--',
    reason,
  ].join('\n');

  return { html, text };
}
