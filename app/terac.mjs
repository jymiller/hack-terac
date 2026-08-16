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
 * There used to be a second question rewarding "the document does not contain enough
 * information". It was written for the retired claims corpus, which withheld a field on
 * ~18% of excerpts. On these certificates every one of the eight answers is printed, and
 * the task page says so — so it screened FOR a behaviour the task never asks for and
 * primed a zero-work answer that still costs a slot, since the charge lands at launch
 * whether or not we approve the payout.
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
        // Submissions land in AWAITING_REVIEW and pay only when we approve. The charge still
        // happens at LAUNCH — this governs payout, not spend — so it buys the ability to
        // withhold payment from a speed-run, not a refund on one.
        review_type: "manual_review",
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
