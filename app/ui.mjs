/**
 * The shared look for the operator-facing pages.
 *
 * Six pages each carried their own near-identical copy of this stylesheet, and they drifted:
 * three of them silently lost the nav rules entirely and rendered the header as a row of
 * run-together underlined links. One copy means that class of bug cannot happen again.
 *
 * The participant-facing task page (extract.mjs) deliberately does NOT use this. It is a
 * light, document-first reading surface for paid strangers, and it should not inherit an
 * operator console's chrome.
 */

export const CSS = `
:root{
  color-scheme:dark;
  --bg:#0a0a0b; --panel:#131316; --card:#161619; --line:#26262b; --line-soft:#1d1d21;
  --fg:#f4f4f5; --mut:#a1a1aa; --dim:#71717a;
  --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; --acc:#60a5fa; --agent:#c084fc; --terac:#a78bfa;
  --r:12px;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px 96px}

/* Header ------------------------------------------------------------------ */
.top{border-bottom:1px solid var(--line);background:linear-gradient(180deg,#101013,var(--bg));
  margin-bottom:28px}
.top .wrap{padding-top:18px;padding-bottom:0}
.brand{display:flex;align-items:baseline;gap:10px;margin-bottom:14px}
.brand b{font-size:14px;letter-spacing:-.01em;font-weight:650}
.brand span{font-size:12px;color:var(--dim)}
.brand span::before{content:'· '}
nav{display:flex;gap:2px;flex-wrap:wrap;font-size:13px}
nav a{color:var(--mut);text-decoration:none;padding:7px 11px;border-radius:7px 7px 0 0;
  border-bottom:2px solid transparent;margin-bottom:-1px}
nav a:hover{color:var(--fg);background:var(--line-soft)}
nav a.on{color:var(--fg);border-bottom-color:var(--acc)}

/* Type -------------------------------------------------------------------- */
h1{font-size:26px;margin:0 0 6px;letter-spacing:-.02em;font-weight:650}
h2{font-size:11.5px;text-transform:uppercase;letter-spacing:.11em;color:var(--dim);
  margin:34px 0 12px;font-weight:600}
.lede{font-size:17px;line-height:1.45;margin:0 0 6px}
.sub{color:var(--mut);font-size:13.5px;margin:0 0 22px;max-width:76ch}

/* The "so what" line that sits under a figure and says what to conclude. */
.sowhat{color:var(--mut);font-size:13px;line-height:1.5;margin:14px 0 0;
  padding-left:11px;border-left:2px solid var(--line);max-width:82ch}
.sowhat b{color:var(--fg);font-weight:600}

/* Surfaces ---------------------------------------------------------------- */
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:18px}
.card + .card{margin-top:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
.grid > div{background:var(--card);padding:15px 16px}
label{font-size:10.5px;color:var(--dim);display:block;text-transform:uppercase;
  letter-spacing:.07em;font-weight:600;margin-bottom:5px}
.big{font-size:26px;font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1.1}
.big small{font-size:14px;color:var(--mut);font-weight:400;letter-spacing:0}

/* Tables ------------------------------------------------------------------ */
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;
  color:var(--dim);padding:0 10px 9px;border-bottom:1px solid var(--line);font-weight:600}
td{padding:10px;border-bottom:1px solid var(--line-soft);vertical-align:top}
tr:last-child td{border-bottom:0}
tbody tr:hover td{background:#1a1a1e}
.num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}

/* Bits -------------------------------------------------------------------- */
.tag{display:inline-block;font-size:9.5px;letter-spacing:.07em;font-weight:600;
  padding:3px 8px;border-radius:99px;border:1px solid currentColor}
.chip{display:inline-block;font-size:11px;border:1px solid var(--line);border-radius:99px;
  padding:3px 9px;color:var(--mut);white-space:nowrap}
.banner{border-radius:10px;padding:12px 14px;font-size:13.5px;margin:0 0 22px;border:1px solid}
.banner.live{border-color:#1d4b2f;background:#0e1c14;color:var(--ok)}
.banner.syn{border-color:#4a3a12;background:#1b160a;color:var(--warn)}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.mut{color:var(--mut)}
.dim{color:var(--dim)}
a{color:var(--acc)}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--mut)}
pre{background:#0d0d10;border:1px solid var(--line);border-radius:9px;padding:12px;
  overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:10px 0 0}

/* Controls ---------------------------------------------------------------- */
button{background:var(--acc);color:#06121f;border:0;border-radius:8px;padding:9px 15px;
  font:inherit;font-weight:600;cursor:pointer}
button:hover{filter:brightness(1.08)}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
button.ghost:hover{border-color:var(--mut);filter:none}
button.danger{background:var(--bad);color:#1b0505}
button:disabled{opacity:.35;cursor:not-allowed;filter:none}
select,input{background:#0d0d10;color:var(--fg);border:1px solid var(--line);border-radius:8px;
  padding:9px 11px;font:inherit}
select:focus,input:focus{outline:2px solid var(--acc);outline-offset:-1px}
.row{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}
`;

// Order is the argument: what a read costs, then who reads well, then whether the comparison
// was fair, then what recruitment leaked, then the controls. "Coverage" was renamed because
// nobody could say what a coverage engine was, including the person who commissioned it.
const TABS = [
  ["/", "Economics"],
  ["/results", "Evaluations"],
  ["/design", "Designer"],
  ["/funnel", "Funnel"],
  ["/readiness", "Readiness"],
  ["/ops", "Operator"],
  ["/support", "Support"],
];

/** The masthead. `current` is the pathname of the page drawing it. */
export function header(current) {
  return `<div class="top"><div class="wrap">
<div class="brand"><b>Human Attestation</b><span>The Cost of Trust</span></div>
<nav>${TABS.map(([href, label]) =>
    `<a href="${href}"${href === current ? ' class="on"' : ""}>${label}</a>`,
  ).join("")}</nav>
</div></div>`;
}

/** Whole page shell: one place that owns doctype, head, stylesheet and masthead. */
export function page({ title, current, body, extraCss = "", script = "" }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${CSS}${extraCss}</style></head><body>
${header(current)}
<div class="wrap">${body}</div>
${script ? `<script>${script}</script>` : ""}
</body></html>`;
}
