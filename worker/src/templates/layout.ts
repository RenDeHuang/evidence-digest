import { escapeHtml } from '../http';

export { escapeHtml };

/** Shared HTML email shell: table layout, inline styles, dark-mode-friendly
 * colours via a <style> block (with sane light-mode fallbacks for clients
 * that strip <style>), no external images or web fonts, max width 600px. */
export function renderEmailShell(params: { title: string; preheader: string; bodyHtml: string; footerHtml: string }): string {
  const { title, preheader, bodyHtml, footerHtml } = params;
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
  body, table, td { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  body { margin:0; padding:0; background-color:#f4f5f7; }
  a { color:#2b6cb0; }
  .bg { background-color:#f4f5f7; }
  .card { background-color:#ffffff; }
  .text { color:#1a1d23; }
  .muted { color:#5c6270; }
  .border { border-color:#e6e8eb; }
  .btn { background-color:#1f6feb; color:#ffffff !important; }
  @media (prefers-color-scheme: dark) {
    .bg { background-color:#0f1115 !important; }
    .card { background-color:#181b21 !important; }
    .text { color:#e8e9ec !important; }
    .muted { color:#9aa0ac !important; }
    .border { border-color:#2a2e37 !important; }
    a { color:#7bb0e8 !important; }
    .btn { background-color:#3b82f6 !important; color:#ffffff !important; }
  }
</style>
</head>
<body class="bg" style="margin:0; padding:0; background-color:#f4f5f7;">
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">
    ${escapeHtml(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg" style="background-color:#f4f5f7;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" class="card" style="width:100%; max-width:600px; background-color:#ffffff; border-radius:12px; overflow:hidden;">
          <tr>
            <td style="padding:28px 28px 8px 28px;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td class="border" style="padding:20px 28px 28px 28px; border-top:1px solid #e6e8eb; margin-top:12px;">
              ${footerHtml}
            </td>
          </tr>
        </table>
        <div style="max-width:600px; margin:16px auto 0; text-align:center;">
          <span class="muted" style="font-size:12px; color:#5c6270;">Evidence Digest &middot; deterministic study alerts, no ads, no tracking pixels</span>
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function button(href: string, label: string): string {
  return `<a class="btn" href="${escapeHtml(href)}" style="display:inline-block; background-color:#1f6feb; color:#ffffff; text-decoration:none; font-size:14px; font-weight:600; padding:11px 20px; border-radius:8px;">${escapeHtml(label)}</a>`;
}
