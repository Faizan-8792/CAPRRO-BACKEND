// Mutations for the leftover batching (W11 IN11).
//
//   MONGODB_URI=mongodb://127.0.0.1:27117/scratch-ai-task node tools/mutation-harness.mjs tools/mutations/ai-task-batching.mjs
//
// IN11 sends what no rule explains in batches of 20: one mutation sends everything in one call, one drops the last
// partial batch.

export const suite = "tests/ai-task-contract.mjs";

export const mutations = [
  {
    name: "1. the residue task sends 60 at a time",
    target: "src/services/ai/tasks/gst-cause-residue.js",
    find: "  batchSize: 20,",
    replace: "  batchSize: 60,",
  },
  {
    name: "2. the last partial batch is never sent",
    target: "src/services/ai/ai-task.service.js",
    find: "  for (let start = 0; start < pending.length; start += task.batchSize) {",
    replace: "  for (let start = 0; start + task.batchSize <= pending.length; start += task.batchSize) {",
  },
];
