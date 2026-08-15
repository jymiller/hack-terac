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
    title: `Does this short excerpt support this statement? (${claimsPerTask} items, ~${minutes} min)`,
    internal_title: "Coverage engine — calibration wave 1",
    description:
      `You will see ${claimsPerTask} short business-document excerpts. Each comes with one sentence a computer wrote about it. For each, say whether the excerpt supports that sentence, contradicts it, or does not contain enough to tell. Answer only from the excerpt shown. All documents are fictional examples created for this study and contain no real company, person, or account.`,
    project_id: projectId,
    num_participants: participants,
    business_type: businessType,
    // Recruiting window in calendar days, minimum 5. It is a window, not a delay:
    // participants can complete immediately.
    expected_days_to_complete: days,
    unrestricted_audience: true,
    device_types: ["desktop", "mobile_ios", "mobile_android"],
    tasks: [
      {
        sequence: 1,
        task_type: "activity",
        // Pays automatically on completion, which requires a task_url whose page
        // redirects to Terac's callback. Ours does.
        review_type: "auto_approve",
        title: `Grounded-claim verification — ${claimsPerTask} short items`,
        description:
          "Read each excerpt and decide whether it supports the sentence shown, contradicts it, or does not say enough to tell.",
        task_url: taskUrl,
        duration_minutes: minutes,
      },
    ],
    screening_questions: [
      {
        key: "doc_comfort",
        text: "Which best describes how often you read business or financial documents such as invoices, account statements, or contracts?",
        pick: "one",
        answers: [
          { text: "Regularly, as part of my work or personal finances", qualify_logic: "may" },
          { text: "Occasionally", qualify_logic: "may" },
          { text: "Almost never, and I find documents with numbers difficult", qualify_logic: "reject" },
          { text: "None of the above", qualify_logic: "reject" },
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
