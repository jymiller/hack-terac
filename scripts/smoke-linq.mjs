/**
 * Prove the app can text an iPhone over iMessage.
 *
 *   node --env-file=.env scripts/smoke-linq.mjs +12025551234
 *   node --env-file=.env scripts/smoke-linq.mjs            # uses LINQ_TEST_NUMBER
 *
 * SKIPPED (exit 0) when LINQ_API_KEY or a target number is absent.
 *
 * Sandbox note (linqapp.com/hackathon): sends are inbound-first — text your Linq
 * number once from the target iPhone before running this, or the send is rejected.
 */
import { listPhoneNumbers, sendMessage, toE164 } from "../app/linq.mjs";

const number = process.argv[2] ?? process.env.LINQ_TEST_NUMBER;

if (!process.env.LINQ_API_KEY) {
  console.log("SKIPPED: LINQ_API_KEY is not set (get one at https://dashboard.linqapp.com/sandbox-signup)");
  process.exit(0);
}
if (!number) {
  console.log("SKIPPED: no target number. Pass one as argv[2] or set LINQ_TEST_NUMBER=+1... in .env");
  process.exit(0);
}

let to;
try {
  to = toE164(number);
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
}

try {
  const lines = await listPhoneNumbers();
  console.log("sending lines on this key:", JSON.stringify(lines).slice(0, 400));
} catch (err) {
  console.warn(`(could not list lines: ${err.message})`);
}

try {
  const stamp = new Date().toISOString().slice(11, 19);
  const res = await sendMessage({
    to,
    text:
      `[coverage engine] Linq smoke test ${stamp} UTC.\n` +
      `If you can read this, the promotion-approval channel is live.\n` +
      `Tapback this message to check reactions: Like/Love = APPROVE, Dislike = BLOCK.`,
    idempotencyKey: `smoke-${Date.now()}`,
  });
  console.log(JSON.stringify(res.raw, null, 2));
  console.log(
    `PASS: sent to ${to} from ${res.from} over ${res.service} ` +
      `(message ${res.messageId}, chat ${res.chatId}, ${res.reason})`,
  );
  process.exit(0);
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  if (err.docUrl) console.error(`  docs: ${err.docUrl}`);
  if (err.traceId) console.error(`  trace: ${err.traceId}`);
  process.exit(1);
}
