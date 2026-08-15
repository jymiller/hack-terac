const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const CSS = `
:root{color-scheme:light dark;--bg:#fbfaf8;--fg:#18181b;--mut:#6b7280;--line:#e4e4e7;--card:#fff;--warn:#b45309;--ok:#166534}
@media(prefers-color-scheme:dark){:root{--bg:#0c0c0d;--fg:#f4f4f5;--mut:#a1a1aa;--line:#27272a;--card:#161617;--warn:#fbbf24;--ok:#4ade80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:920px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:36px 0 10px}
.sub{color:var(--mut);margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:14px}
.claim{margin-bottom:22px}
.ev{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}
.prop{font-weight:600;margin:12px 0 4px}
.mach{color:var(--mut);font-size:14px;margin-bottom:10px}
label.opt{display:block;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:6px;cursor:pointer}
label.opt:hover{border-color:var(--mut)}
button{background:var(--fg);color:var(--bg);border:0;border-radius:8px;padding:12px 22px;font-size:16px;font-weight:600;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;padding:2px 7px;border-radius:5px;border:1px solid var(--line)}
.syn{color:var(--warn);border-color:var(--warn)}.live{color:var(--ok);border-color:var(--ok)}
.mono{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.banner{border:1px solid var(--warn);color:var(--warn);border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:14px}
.note{color:var(--mut);font-size:13px}
`;

const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;

const ANSWERS = [
  ["AGREE", "Yes — the excerpt supports the statement"],
  ["CORRECT", "No — the excerpt contradicts the statement"],
  ["INSUFFICIENT", "The excerpt does not contain enough to tell"],
  ["RECUSE", "I cannot judge this one"],
];

export function taskPage({ submissionId, taskId, opportunityId, claims }) {
  const items = claims
    .map(
      (c, i) => `<div class="claim">
<div class="note">Item ${i + 1} of ${claims.length}</div>
<div class="ev">${esc(c.evidence)}</div>
<div class="prop">Statement: ${esc(c.proposition)}</div>
<div class="mach">Does the excerpt above support that statement?</div>
${ANSWERS.map(
  ([v, l]) =>
    `<label class="opt"><input type="radio" name="item_${esc(c.id)}" value="${v}" required> ${esc(l)}</label>`,
).join("")}
</div>`,
    )
    .join("");

  return page(
    "Check these statements against the excerpts",
    `<h1>Does the excerpt support the statement?</h1>
<p class="sub">${claims.length} short items, about 3 minutes. Answer only from the excerpt shown — please do not search anywhere else.</p>
<div class="banner">Every document here is a fictional example written for this study. No real company, person, or account appears anywhere in it.</div>
<form method="post" action="/api/terac/responses">
<input type="hidden" name="teracSubmissionId" value="${esc(submissionId)}">
<input type="hidden" name="taskId" value="${esc(taskId ?? "")}">
<input type="hidden" name="opportunityId" value="${esc(opportunityId ?? "")}">
<div class="card">${items}</div>
<button type="submit">Submit answers</button>
</form>`,
  );
}

export function donePage() {
  return page("Thank you", `<h1>Thank you — your answers were recorded.</h1><p class="sub">You can close this tab.</p>`);
}

export function coveragePage({ rows, mapped, totals, floor }) {
  const body = rows
    .map(
      (r) => `<tr>
<td><strong>${esc(r.name)}</strong><br><span class="note">${esc(r.expertise_area)}</span></td>
<td class="mono">${r.claims || 0}</td>
<td class="mono">${r.judgments || 0}</td>
<td class="mono">${r.agreement === null ? "—" : (r.agreement * 100).toFixed(0) + "%"}</td>
<td class="mono">${r.lower === null ? "0.000" : r.lower.toFixed(3)}</td>
<td>${esc(r.label)}</td>
<td><span class="tag ${r.evidence_mode === "live" ? "live" : "syn"}">${r.evidence_mode.toUpperCase()}</span></td>
</tr>`,
    )
    .join("");

  const mappedRows = mapped
    .map(
      (m) => `<tr><td>${esc(m.name)}<br><span class="note">${esc(m.expertise_area)}</span></td>
<td class="mono">0</td><td class="mono">0</td><td class="mono">—</td><td class="mono">0.000</td>
<td>UNMEASURED</td><td><span class="tag syn">MAPPED</span></td></tr>`,
    )
    .join("");

  return page(
    "Coverage Engine",
    `<nav style="display:flex;gap:18px;margin:0 0 22px;padding-bottom:12px;border-bottom:1px solid var(--line);font-size:13px"><a href="/" style="color:var(--fg)">Coverage board</a><a href="/ops" style="color:var(--mut)">Operator</a><a href="/design" style="color:var(--mut)">Designer</a></nav><h1>Coverage Engine</h1>
<p class="sub">Automation readiness per kind of expert judgment in deal onboarding, licensed by human attestation.</p>
<div class="banner">Readiness is the 95% lower bound on machine–human agreement, not the observed rate. A process with no human attestations licenses exactly 0.000. Floor = ${floor.toFixed(2)}.</div>
<h2>Measured — ${rows.filter((r) => r.evidence_mode === "live").length} of ${rows.length + mapped.length} processes</h2>
<div class="card"><table>
<tr><th>Process</th><th>Claims</th><th>Judgments</th><th>Agreement</th><th>Licensed</th><th>Verdict</th><th>Evidence</th></tr>
${body}${mappedRows}
</table></div>
<h2>Human input</h2>
<div class="card"><p class="mono">${totals.judgments} attestations · ${totals.claims} claims · $${totals.cost.toFixed(2)} spent · $${totals.perJudgment} per judgment</p>
<p class="note">Terac is the calibration instrument, not a delivery route. The system recommends, never attests; it records, never activates. No policy promotes itself — promotion needs a named human and a fresh held-out pass.</p></div>`,
  );
}
