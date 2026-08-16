const BASE = process.env.TERAC_BASE_URL ?? "https://terac.com/api/external/v2";

async function call(path, { method = "POST", body } = {}) {
  const key = process.env.TERAC_API_KEY;
  if (!key) throw new Error("TERAC_API_KEY is not set");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.message ?? text.slice(0, 300);
    const err = new Error(`Terac ${method} ${path} -> ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = json ?? text;
    throw err;
  }
  return json ?? text;
}

/**
 * Screeners GATE only; they collect no analysis. Every closed pick carries a `reject`
 * answer, because a question where nothing rejects screens nobody out and just spends
 * the panel's time. Answers deliberately do not reveal which one qualifies.
 *
 * The second question is the load-bearing one: our corpus withholds a required field on
 * ~18% of claims, so the honest answer there is "not enough information". Someone who
 * guesses anyway, or who goes looking outside the excerpt, produces a confident wrong
 * attestation — the exact failure we are trying to measure in the machine.
 */
export function opportunityBody({
  projectId,
  taskUrl,
  participants = 12,
  minutes = 3,
  days = 5,
  claimsPerTask = 4,
  businessType = "b2c",
}) {
  return {
    title: `Read a compliance certificate and report 8 values it prints (~${minutes} min)`,
    internal_title: "Coverage engine — certificate extraction",
    description:
      `You will be shown a short financial compliance certificate — two or three pages — and asked to type eight values that are printed in it: the entity it is for, the date its reporting period ended, the name of the main financial ratio it certifies, that ratio\u2019s value, the two figures the ratio is calculated from, one threshold, and whether the certificate states the entity is compliant.\n\nNo finance background is needed and there is nothing to calculate. Every answer is already printed somewhere in the document; the work is finding it and copying it accurately. If the document does not state something, you say so.\n\nThe documents are synthetic examples created for testing and describe no real company, person, or account.`,
    project_id: projectId,
    num_participants: participants,
    business_type: businessType,
    // Recruiting window in calendar days, minimum 5. It is a window, not a delay:
    // participants can complete immediately.
    expected_days_to_complete: days,
    unrestricted_audience: true,
    // Desktop only. The task is finding small figures in a dense multi-page scan, and two of
    // the three certificates put a registered distractor on a LATER page. A phone reader who
    // cannot comfortably reach page 2 is not careless — we hid the evidence from them, and we
    // would score it as a trap taken. Omitting this field would allow mobile by default.
    device_types: ["desktop"],
    tasks: [
      {
        sequence: 1,
        task_type: "activity",
        // Pays automatically on completion, which requires a task_url whose page redirects to
        // Terac's callback. Ours does. Owner's call: a speed-run therefore cannot be refused
        // payment, and the defence against one is the screener plus duration_ms, not review.
        review_type: "auto_approve",
        title: `Certificate reading — 8 values to find and report`,
        description:
          "Open the certificate, find the eight values listed on the page, and type them in. Answer only from the document shown.",
        task_url: taskUrl,
        duration_minutes: minutes,
      },
    ],
    screening_questions: [
      {
        // The previous version of this question rejected 0 of 14 applicants: every answer
        // qualified, so it screened nobody and only spent panel time. This one tests the
        // behaviour the task actually depends on — copying a printed figure exactly.
        key: "transcription",
        text: "A document prints a figure as 5.43. Reporting it to us, what would you type?",
        pick: "one",
        answers: [
          { text: "5.43", qualify_logic: "may" },
          { text: "5.4, rounded", qualify_logic: "reject" },
          { text: "About 5", qualify_logic: "reject" },
          { text: "Whatever the surrounding text says it should be", qualify_logic: "reject" },
        ],
      },
      {
        key: "insufficient_behaviour",
        text: "Suppose you are asked a question about a document, but the document simply does not contain the information needed to answer it. What would you do?",
        pick: "one",
        answers: [
          { text: "Say the document does not contain enough information", qualify_logic: "may" },
          { text: "Give my best guess based on what is there", qualify_logic: "reject" },
          { text: "Look the missing information up online", qualify_logic: "reject" },
          { text: "None of the above", qualify_logic: "reject" },
        ],
      },
    ],
  };
}

/** Human-confirmed pricing. Beats the autonomous estimate when the task is simpler than it looks. */
export const requestFeasibility = ({ role, task, count }) =>
  call("/feasibility/requests", { body: { role, task, count } });
export const getFeasibility = (id) => call(`/feasibility/requests/${id}`, { method: "GET" });

export const listProjects = () => call("/projects", { method: "GET" });
export const createProject = (name) => call("/projects", { body: { name } });
export const createOpportunity = (body) => call("/opportunities", { body });
export const getOpportunity = (id) => call(`/opportunities/${id}`, { method: "GET" });
export const launchOpportunity = (id) => call(`/opportunities/${id}/launch`, { body: {} });
export const stopOpportunity = (id) => call(`/opportunities/${id}/stop`, { body: {} });
export const getSubmissions = (id, params = "") =>
  call(`/opportunities/${id}/submissions${params}`, { method: "GET" });
export const getContext = () => call("/organizations/current/context", { method: "GET" });
