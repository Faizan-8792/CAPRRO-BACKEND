// src/services/ai/tasks/index.js
//
// W11 IN5: the registry of AI tasks runAiTask accepts. One file per task holds everything about it - its
// operation name (metered in ProviderUsage), its prompt and version, its batch size and its validator - so a
// task is reviewed in one place.
//
// `modelOff`: a task whose live evaluation (tools/ai-eval.mjs, IN6) misses the ship bar - precision of 85% or
// more where it answered, a false-confident rate of 5% or less - is switched off here, with the measured
// figures in `modelOffNote`'s comment, and its surface keeps its rule or template half only.

import gstCauseResidue from "./gst-cause-residue.js";
import supplierChaseDraft from "./supplier-chase-draft.js";
import importMappingSuggest from "./import-mapping-suggest.js";
import tdsActionDraft from "./tds-action-draft.js";

const TASKS = Object.freeze(
  Object.fromEntries([gstCauseResidue, supplierChaseDraft, importMappingSuggest, tdsActionDraft].map((task) => [task.name, task])),
);

export const AI_TASK_NAMES = Object.freeze(Object.keys(TASKS));

export function getAiTask(name) {
  return Object.prototype.hasOwnProperty.call(TASKS, name) ? TASKS[name] : null;
}
