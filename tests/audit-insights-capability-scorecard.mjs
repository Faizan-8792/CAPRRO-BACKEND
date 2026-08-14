// tests/audit-insights-capability-scorecard.mjs
//
// Root-cause regression tests for six specific weak capabilities the human
// identified via a direct scorecard (not free-form critique) rating ten
// named capabilities individually:
//
//   Capability                        | Rating
//   Handling contradictory evidence   | needs improvement (inconsistent)
//   Related-party technical judgment  | needs improvement
//   Going-concern judgment            | needs improvement
//   Subsequent-event detection        | major gap demonstrated (worst-rated)
//   Avoiding generic procedures       | needs improvement
//   Knowing when NOT to conclude      | needs improvement
//
// The other four capabilities (finding obvious issues, finding quantitative
// misstatements, selecting procedures, using standards) were already rated
// good-to-excellent and are unchanged by this batch.
//
// All six were root-caused to the SAME mechanism: insightsHardRulesBlock()
// already told the model to CITE SA 550/560/570 for related-party,
// subsequent-events and going-concern findings (the FRAMEWORK / STANDARD
// SELECTION rule), but never told it HOW to apply the substantive judgment
// those standards actually require - a citation instruction is not a
// judgment framework. Contradictory-evidence handling and "knowing when not
// to conclude" had no corresponding self-check question at all. Generic
// procedures had a rule against repetition but no rule connecting a
// procedure's wording to its own evidence. None of the six needed a new
// mechanism - every fix below extends the existing hard-rules block and the
// existing self-check, the same file convention audit-insights-reasoning-
// pipeline.mjs already established for the pipeline's own prior extension.
//
// These are prompt-content assertions - the actual judgment is the model's -
// so what is pinned here is that the instruction reaching the model is the
// corrected one, which is what is actually within this codebase's control.
// Live-model verification against the two real fixtures (Stellar Textiles,
// Orion Industrial) is done separately via tools/run-insights-fixture.mjs,
// which this static suite cannot replace.

process.env.DEEPSEEK_API_KEY =
  process.env.DEEPSEEK_API_KEY || "test-key-not-used";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

let capturedPrompts = [];

globalThis.fetch = async (_url, options) => {
  const body = options?.body ? JSON.parse(options.body) : null;
  const userPrompt = body?.messages?.find((m) => m.role === "user")?.content;
  if (userPrompt) capturedPrompts.push(userPrompt);

  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              result: "INSUFFICIENT_EVIDENCE",
              insufficientEvidenceReason: "test probe, no real content needed",
              insights: [],
            }),
          },
        },
      ],
    }),
    text: async () => "",
  };
};

const { generateInsights } =
  await import("../src/controllers/audit.controller.js");

function fakeReqRes(body) {
  const state = { status: 200, body: null };
  const req = { body };
  const res = {
    status(code) {
      state.status = code;
      return res;
    },
    json(payload) {
      state.body = payload;
      return res;
    },
  };
  return { req, res, state };
}

async function callInsights(body) {
  capturedPrompts = [];
  const { req, res, state } = fakeReqRes(body);
  let nextErr = null;
  await generateInsights(req, res, (err) => {
    nextErr = err;
  });
  if (nextErr) throw nextErr;
  return state;
}

// ─── 1. Contradictory evidence handling ──────────────────────────────────
// The self-check must ask whether a finding contradicts another finding, or
// management's own stated position, and the hard rules must say what to do
// about it (quote both, state the conflict, make resolving it the required
// procedure) rather than silently picking the more serious-sounding side.

{
  await callInsights({
    rawText: "Some audit-relevant text with two passages that disagree.",
    topicName: "General audit",
  });
  const prompt = capturedPrompts[0] || "";

  check(
    "contradictory evidence: the self-check asks whether a finding contradicts another finding or a stated position",
    /contradict another finding I am about to produce, or a statement made elsewhere/i.test(
      prompt,
    ),
  );
  check(
    "contradictory evidence: the hard rules forbid silently picking the more serious passage or blending the two",
    /CONTRADICTORY EVIDENCE/i.test(prompt) &&
      /do NOT silently pick the passage that sounds more serious/i.test(
        prompt,
      ) &&
      /do NOT average or blend them into one smoothed-over statement/i.test(
        prompt,
      ),
  );
  check(
    "contradictory evidence: the rule makes resolving the conflict itself the required procedure",
    /make the required procedure the act of resolving the conflict itself/i.test(
      prompt,
    ),
  );
  check(
    "contradictory evidence: the rule states a contradiction is frequently the finding in its own right",
    /the contradiction is frequently the finding in its own right/i.test(
      prompt,
    ),
  );
}

// ─── 2. Related-party technical judgment (SA 550) ────────────────────────
// The rule must name all three substantive SA 550 questions - arm's-length
// comparison, approval, and the two SEPARATE disclosure-completeness
// questions (relationship disclosed vs transaction disclosed) - not just
// cite the standard number.

{
  await callInsights({
    rawText: "A loan was made to a director's relative at a reduced rate.",
    topicName: "RelatedParty",
  });
  const prompt = capturedPrompts[0] || "";

  check(
    "related-party judgment: the rule requires stating whether pricing/terms differ from an unrelated third party would receive",
    /whether the pricing or terms differ from what an unrelated third party would receive/i.test(
      prompt,
    ),
  );
  check(
    "related-party judgment: an absent comparator must be treated as a gap to close, not assumed fine",
    /if the text gives no comparator, the procedure must be to obtain one/i.test(
      prompt,
    ),
  );
  check(
    "related-party judgment: the rule requires checking board/audit-committee approval and forbids assuming it from silence",
    /treat that silence as an open gap to close, not as approval that can be assumed/i.test(
      prompt,
    ),
  );
  check(
    "related-party judgment: the rule separates relationship-disclosure from transaction-disclosure as two distinct completeness questions",
    /these are two separate completeness questions, not one/i.test(prompt),
  );
  check(
    "related-party judgment: a bare 'confirm this is arm's length' procedure is explicitly named as the generic failure to avoid",
    /A related-party finding that only says "confirm this is arm's length"/i.test(
      prompt,
    ),
  );
}

// ─── 3. Going-concern judgment (SA 570) ──────────────────────────────────
// The rule must embed the standard SA 570 indicator taxonomy (financial,
// operating, other) so the model checks against named categories rather
// than free-form judgment, and must forbid the model from rendering an
// ultimate going-concern verdict itself.

{
  await callInsights({
    rawText: "A working capital facility is due for renewal shortly.",
    topicName: "Borrowings",
  });
  const prompt = capturedPrompts[0] || "";

  check(
    "going-concern judgment: the FINANCIAL indicator category is present with concrete examples",
    /FINANCIAL indicators:/i.test(prompt) &&
      /net liability or net current liability position/i.test(prompt) &&
      /breached loan covenant/i.test(prompt),
  );
  check(
    "going-concern judgment: the OPERATING indicator category is present",
    /OPERATING indicators:/i.test(prompt) &&
      /loss of a key customer, supplier, market/i.test(prompt),
  );
  check(
    "going-concern judgment: the OTHER indicator category is present",
    /OTHER indicators:/i.test(prompt) &&
      /pending legal or regulatory proceedings/i.test(prompt),
  );
  check(
    "going-concern judgment: indicators must be checked for regardless of the stated topic, not only on a dedicated going-concern document",
    /genuinely check for these even when the topic is not going concern/i.test(
      prompt,
    ),
  );
  check(
    "going-concern judgment: the rule names concrete SA 570 evaluation procedures beyond a bare 'assess going concern'",
    /must go beyond "assess going concern" and name the actual SA 570 evaluation step/i.test(
      prompt,
    ),
  );
  check(
    "going-concern judgment: the model is forbidden from rendering the ultimate going-concern verdict itself",
    /Do not conclude the entity IS or IS NOT a going concern yourself/i.test(
      prompt,
    ),
  );
}

// ─── 4. Subsequent-event detection (SA 560) — the worst-rated capability ─
// The rule must require identifying the two governing dates, classifying
// an event as adjusting vs non-adjusting, distinguishing a subsequent event
// from a same-period cut-off issue, and actively watching for the
// linguistic signals of a subsequent event even with no explicit heading.

{
  await callInsights({
    rawText: "A customer became insolvent shortly after the year end.",
    topicName: "Receivables",
  });
  const prompt = capturedPrompts[0] || "";

  check(
    "subsequent-event detection: the rule requires identifying both governing dates (reporting date and report date)",
    /the balance sheet \/ reporting date, and the date the auditor's report is signed/i.test(
      prompt,
    ),
  );
  check(
    "subsequent-event detection: an unstated report date must be flagged as a procedure, not assumed to qualify",
    /confirm the date of the auditor's report to determine whether this event falls within the subsequent-events period/i.test(
      prompt,
    ),
  );
  check(
    "subsequent-event detection: the rule requires classifying the event as ADJUSTING or NON-ADJUSTING with a worked example of each",
    /ADJUSTING \(it provides evidence of a condition that existed AT the reporting date/i.test(
      prompt,
    ) &&
      /NON-ADJUSTING \(a condition that arose AFTER the reporting date/i.test(
        prompt,
      ),
  );
  check(
    "subsequent-event detection: the rule states the two classifications require different actions (adjust vs disclose only)",
    /an adjusting event means the figures in the statements may need to change, a non-adjusting material event means disclosure only/i.test(
      prompt,
    ),
  );
  check(
    "subsequent-event detection: an event before the reporting date is explicitly ruled a cut-off issue, not a subsequent event",
    /an event before the reporting date is a cut-off issue/i.test(prompt),
  );
  check(
    "subsequent-event detection: the rule instructs actively watching for linguistic signals even without an explicit heading",
    /actively look for language that signals one even when no explicit heading names it/i.test(
      prompt,
    ) &&
      /"since year-end"/i.test(prompt) &&
      /"subsequently"/i.test(prompt),
  );
}

// ─── 5. Avoiding generic procedures ───────────────────────────────────────
// The rule must give a worked contrast between a generic procedure and a
// document-specific one, and a mechanical test tying "detail" to "evidence"
// (substitution test) so a generic procedure can be checked for, not just
// asked to be avoided in the abstract.

{
  await callInsights({
    rawText: "Some audit-relevant text about a specific transaction.",
    topicName: "GeneralAudit",
  });
  const prompt = capturedPrompts[0] || "";

  check(
    "avoiding generic procedures: the rule names the failure mode directly - a detail that would read the same on a different document",
    /a "detail" that would read exactly the same on a different document about the same topic area is too generic/i.test(
      prompt,
    ),
  );
  check(
    "avoiding generic procedures: the rule gives a worked contrast between a generic and a document-specific procedure",
    /Obtain confirmation of the balance" or "Assess whether the provision is adequate" are the topic's standard textbook procedure/i.test(
      prompt,
    ) && /Vantage Garments LLC/i.test(prompt),
  );
  check(
    "avoiding generic procedures: the rule gives a mechanical substitution test tying detail to its own evidence",
    /if the same "detail" text would still make sense with a different, unrelated "evidence" quotation substituted in, it has not used the evidence/i.test(
      prompt,
    ),
  );
}

// ─── 6. Knowing when NOT to conclude ──────────────────────────────────────
// Two independent fixes: (a) a self-check question naming the target-count
// quota as an explicitly wrong reason to include a finding, and (b) the
// PRIMARY prompt (not only the coverage-check prompt, which already had
// this) must state producing fewer findings than the target is the correct
// answer for a narrow document, worded as a ceiling rather than a quota.

{
  await callInsights({
    rawText: "A single narrow finding about one transaction.",
    topicName: "GeneralAudit",
  });
  const prompt = capturedPrompts[0] || "";

  check(
    "knowing when not to conclude: the self-check asks whether a finding is included only to reach the target count",
    /Am I including this finding because the evidence genuinely supports it, or to reach the target count/i.test(
      prompt,
    ),
  );
  check(
    "knowing when not to conclude: the hard rules state producing fewer findings than the target is correct and expected",
    /IT IS CORRECT, AND EXPECTED, TO PRODUCE FEWER FINDINGS THAN THE TARGET COUNT/i.test(
      prompt,
    ),
  );
  check(
    "knowing when not to conclude: the rule forbids padding the list to reach the target number",
    /just to reach the target number/i.test(prompt),
  );
  check(
    "knowing when not to conclude: the PRIMARY prompt's own instruction line words the count as 'up to' a ceiling, not a fixed quota",
    /Produce UP TO .* document-specific AUDIT PROCEDURES/i.test(prompt) &&
      /this is a ceiling to select up to, not a quota to fill/i.test(prompt),
  );
}

// ─── Report ───────────────────────────────────────────────────────

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(
    `[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`,
  );
}

const total = checks.length;
console.log(`\nAudit insights capability scorecard: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
