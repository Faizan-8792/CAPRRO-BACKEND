import ImportBatch from "../models/ImportBatch.js";
import ImportRow from "../models/ImportRow.js";
import ReconciliationItem from "../models/ReconciliationItem.js";
import ReconciliationRun from "../models/ReconciliationRun.js";

const IMPORT_INDEX_SPECS = Object.freeze([
  {
    Model: ImportBatch,
    label: "import identity",
    key: [["firmId", 1], ["kind", 1], ["importFingerprint", 1]],
    unique: true,
    partialFilterExpression: { importFingerprint: { $type: "string" } },
  },
  {
    Model: ImportRow,
    label: "import row generation",
    key: [["firmId", 1], ["batchId", 1], ["importGeneration", 1], ["sourceRow", 1]],
    unique: true,
    partialFilterExpression: null,
  },
]);

const RECONCILIATION_INDEX_SPECS = Object.freeze([
  {
    Model: ReconciliationRun,
    label: "run source revision",
    key: [["firmId", 1], ["sourceFingerprint", 1], ["revision", 1]],
    unique: true,
    partialFilterExpression: null,
  },
  {
    Model: ReconciliationRun,
    label: "run linear revision",
    key: [["firmId", 1], ["rootRunId", 1], ["revision", 1]],
    unique: true,
    partialFilterExpression: { rootRunId: { $type: "objectId" } },
  },
  {
    Model: ReconciliationRun,
    label: "run single child",
    key: [["firmId", 1], ["parentRunId", 1]],
    unique: true,
    partialFilterExpression: { parentRunId: { $type: "objectId" } },
  },
  {
    Model: ReconciliationItem,
    label: "item generation identity",
    key: [["firmId", 1], ["runId", 1], ["generationAttempt", 1], ["itemKey", 1]],
    unique: true,
    partialFilterExpression: null,
  },
  {
    Model: ReconciliationItem,
    label: "portal row reservation",
    key: [["firmId", 1], ["runId", 1], ["generationAttempt", 1], ["portalRowId", 1]],
    unique: true,
    partialFilterExpression: { portalRowId: { $type: "objectId" } },
  },
]);

const FORBIDDEN_INDEX_SPECS = Object.freeze([
  {
    Model: ImportBatch,
    label: "legacy source-hash import identity",
    key: [["firmId", 1], ["kind", 1], ["sourceHash", 1]],
  },
  {
    Model: ImportRow,
    label: "legacy import row identity",
    key: [["firmId", 1], ["batchId", 1], ["sourceRow", 1]],
  },
  {
    Model: ReconciliationItem,
    label: "legacy reconciliation item identity",
    key: [["firmId", 1], ["runId", 1], ["itemKey", 1]],
  },
  {
    Model: ReconciliationItem,
    label: "legacy portal row reservation",
    key: [["firmId", 1], ["runId", 1], ["portalRowId", 1]],
  },
]);

const GST_IMPORT_KINDS = ["GST_PURCHASE", "GSTR2B", "GSTR3B_SUMMARY"];
const GST_IMPORT_NORMALIZATION_VERSION = "gst-import-v2";
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OPERATION_ID_PATTERN = /^[a-f0-9]{64}$/;
const NONBLANK_ITEM_KEY_PATTERN = /^(?!\s*$)[\s\S]{1,160}$/;
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const GST_BULK_ACTIONS = [
  "SUPPLIER_FOLLOW_UP",
  "MARK_INELIGIBLE",
  "DEFER",
  "ACCEPT_EXCEPTION",
];

function anyPopulated(fields) {
  return {
    $or: fields.map((field) => ({
      $expr: {
        $eq: [
          { $in: [{ $type: `$${field}` }, ["missing", "null"]] },
          false,
        ],
      },
    })),
  };
}

function invalidStringPattern(field, pattern) {
  return {
    $expr: {
      $eq: [
        {
          $cond: [
            { $eq: [{ $type: `$${field}` }, "string"] },
            { $regexMatch: { input: `$${field}`, regex: pattern } },
            false,
          ],
        },
        false,
      ],
    },
  };
}

function invalidObjectId(field) {
  return { $expr: { $ne: [{ $type: `$${field}` }, "objectId"] } };
}

function invalidOptionalType(field, allowedTypes) {
  return {
    $expr: {
      $eq: [
        { $in: [{ $type: `$${field}` }, ["missing", "null", ...allowedTypes]] },
        false,
      ],
    },
  };
}

function invalidOptionalObjectId(field) {
  return invalidOptionalType(field, ["objectId"]);
}

function invalidOptionalDate(field) {
  return invalidOptionalType(field, ["date"]);
}

function invalidOptionalStringPattern(field, pattern) {
  return {
    $expr: {
      $eq: [
        {
          $cond: [
            { $in: [{ $type: `$${field}` }, ["missing", "null"]] },
            true,
            {
              $cond: [
                { $eq: [{ $type: `$${field}` }, "string"] },
                { $regexMatch: { input: `$${field}`, regex: pattern } },
                false,
              ],
            },
          ],
        },
        false,
      ],
    },
  };
}

function invalidObjectIdArray(field) {
  return {
    $expr: {
      $eq: [
        {
          $cond: [
            { $eq: [{ $type: `$${field}` }, "array"] },
            {
              $allElementsTrue: {
                $map: {
                  input: `$${field}`,
                  as: "entry",
                  in: { $eq: [{ $type: "$$entry" }, "objectId"] },
                },
              },
            },
            false,
          ],
        },
        false,
      ],
    },
  };
}

function invalidArrayLength(field, minimum, maximum) {
  return {
    $expr: {
      $eq: [
        {
          $cond: [
            { $eq: [{ $type: `$${field}` }, "array"] },
            {
              $and: [
                { $gte: [{ $size: `$${field}` }, minimum] },
                { $lte: [{ $size: `$${field}` }, maximum] },
              ],
            },
            false,
          ],
        },
        false,
      ],
    },
  };
}

function invalidSubdocumentObjectIdArray(field, idField) {
  return {
    $expr: {
      $eq: [
        {
          $cond: [
            { $eq: [{ $type: `$${field}` }, "array"] },
            {
              $allElementsTrue: {
                $map: {
                  input: `$${field}`,
                  as: "entry",
                  in: { $eq: [{ $type: `$$entry.${idField}` }, "objectId"] },
                },
              },
            },
            false,
          ],
        },
        false,
      ],
    },
  };
}

function invalidSubdocumentUniqueArray(field, idField) {
  return {
    $expr: {
      $eq: [
        {
          $cond: [
            { $eq: [{ $type: `$${field}` }, "array"] },
            {
              $eq: [
                { $size: `$${field}` },
                {
                  $size: {
                    $setUnion: [
                      {
                        $map: {
                          input: `$${field}`,
                          as: "entry",
                          in: `$$entry.${idField}`,
                        },
                      },
                      [],
                    ],
                  },
                },
              ],
            },
            false,
          ],
        },
        false,
      ],
    },
  };
}

function invalidRequiredType(field, allowedTypes) {
  return {
    $expr: {
      $eq: [{ $in: [{ $type: `$${field}` }, allowedTypes] }, false],
    },
  };
}

function invalidSubdocumentIntegerArray(
  field,
  valueField,
  minimum,
  maximum = Number.MAX_SAFE_INTEGER
) {
  return {
    $expr: {
      $eq: [
        {
          $cond: [
            { $eq: [{ $type: `$${field}` }, "array"] },
            {
              $allElementsTrue: {
                $map: {
                  input: `$${field}`,
                  as: "entry",
                  in: {
                    $and: [
                      {
                        $in: [
                          { $type: `$$entry.${valueField}` },
                          ["int", "long", "double", "decimal"],
                        ],
                      },
                      { $gte: [`$$entry.${valueField}`, minimum] },
                      { $lte: [`$$entry.${valueField}`, maximum] },
                      { $eq: [{ $mod: [`$$entry.${valueField}`, 1] }, 0] },
                    ],
                  },
                },
              },
            },
            false,
          ],
        },
        false,
      ],
    },
  };
}

function invalidInteger(field, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  return {
    $expr: {
      $eq: [
        {
          $cond: [
            {
              $in: [
                { $type: `$${field}` },
                ["int", "long", "double", "decimal"],
              ],
            },
            {
              $and: [
                { $gte: [`$${field}`, minimum] },
                { $lte: [`$${field}`, maximum] },
                { $eq: [{ $mod: [`$${field}`, 1] }, 0] },
              ],
            },
            false,
          ],
        },
        false,
      ],
    },
  };
}

function invalidBoolean(field) {
  return { $expr: { $ne: [{ $type: `$${field}` }, "bool"] } };
}

function invalidOptionalEnum(field, values) {
  return {
    $expr: {
      $eq: [
        {
          $or: [
            { $in: [{ $type: `$${field}` }, ["missing", "null"]] },
            {
              $and: [
                { $eq: [{ $type: `$${field}` }, "string"] },
                { $in: [`$${field}`, values] },
              ],
            },
          ],
        },
        false,
      ],
    },
  };
}

function invalidRequiredEnum(field, values) {
  return {
    $expr: {
      $eq: [
        {
          $and: [
            { $eq: [{ $type: `$${field}` }, "string"] },
            { $in: [`$${field}`, values] },
          ],
        },
        false,
      ],
    },
  };
}

function invalidTokenExpiryPair(tokenField, expiryField) {
  return {
    $expr: {
      $eq: [
        {
          $or: [
            {
              $and: [
                { $in: [{ $type: `$${tokenField}` }, ["missing", "null"]] },
                { $in: [{ $type: `$${expiryField}` }, ["missing", "null"]] },
              ],
            },
            {
              $and: [
                { $eq: [{ $type: `$${tokenField}` }, "string"] },
                { $eq: [{ $type: `$${expiryField}` }, "date"] },
              ],
            },
          ],
        },
        false,
      ],
    },
  };
}

function invalidRunLeaseState() {
  return {
    $expr: {
      $eq: [
        {
          $cond: [
            { $eq: ["$reviewMutationActive", true] },
            {
              $and: [
                { $eq: [{ $type: "$reviewMutationToken" }, "string"] },
                { $eq: [{ $type: "$reviewMutationExpiresAt" }, "date"] },
              ],
            },
            {
              $and: [
                {
                  $in: [
                    { $type: "$reviewMutationToken" },
                    ["missing", "null"],
                  ],
                },
                {
                  $in: [
                    { $type: "$reviewMutationExpiresAt" },
                    ["missing", "null"],
                  ],
                },
              ],
            },
          ],
        },
        false,
      ],
    },
  };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])])
  );
}

function indexKeyMatches(index, expectedKey) {
  const actual = Object.entries(index.key || {});
  return (
    actual.length === expectedKey.length &&
    actual.every(
      ([field, direction], position) =>
        field === expectedKey[position][0] &&
        Number(direction) === expectedKey[position][1]
    )
  );
}

function indexSpecMatches(index, spec) {
  if (!indexKeyMatches(index, spec.key)) return false;
  if (spec.unique && index.unique !== true) return false;
  if (index.sparse === true) return false;
  return (
    JSON.stringify(canonicalValue(index.partialFilterExpression || null)) ===
    JSON.stringify(canonicalValue(spec.partialFilterExpression))
  );
}

async function findUnsafeLegacyDocuments({ reconciliation }) {
  const checks = [
    {
      Model: ImportBatch,
      label: "completed GST imports without generation-safe identity",
      filter: {
        kind: { $in: GST_IMPORT_KINDS },
        status: "COMPLETED",
        $or: [
          invalidObjectId("_id"),
          invalidStringPattern("importFingerprint", SHA256_HEX_PATTERN),
          invalidStringPattern("sourceHash", SHA256_HEX_PATTERN),
          invalidStringPattern("activeImportGeneration", UUID_PATTERN),
          { normalizationVersion: { $ne: GST_IMPORT_NORMALIZATION_VERSION } },
          invalidObjectId("firmId"),
          invalidObjectId("clientId"),
          invalidStringPattern("gstin", GSTIN_PATTERN),
          invalidStringPattern("period", PERIOD_PATTERN),
        ],
      },
    },
    {
      Model: ImportRow,
      label: "GST import rows without generation-safe identity",
      filter: {
        $or: [
          invalidObjectId("_id"),
          invalidStringPattern("importGeneration", UUID_PATTERN),
          invalidStringPattern("sourceHash", SHA256_HEX_PATTERN),
          invalidObjectId("firmId"),
          invalidObjectId("batchId"),
          invalidObjectId("clientId"),
          invalidInteger("sourceRow", 2),
        ],
      },
    },
  ];
  if (reconciliation) {
    const reviewedRunFilter = { status: { $in: ["REVIEW", "LOCKING", "LOCKED"] } };
    checks.push(
      {
        Model: ReconciliationRun,
        label: "reviewed reconciliation runs without typed generation and review state",
        filter: {
          ...reviewedRunFilter,
          $or: [
            invalidObjectId("_id"),
            invalidObjectId("firmId"),
            invalidObjectId("clientId"),
            invalidObjectId("rootRunId"),
            invalidOptionalObjectId("parentRunId"),
            invalidObjectId("sourceImports.booksBatchId"),
            invalidObjectId("sourceImports.portalBatchId"),
            invalidOptionalObjectId("sourceImports.gstr3bBatchId"),
            invalidStringPattern("sourceFingerprint", SHA256_HEX_PATTERN),
            invalidInteger("revision", 1),
            invalidInteger("activeGenerationAttempt", 1),
            invalidInteger("reviewVersion", 0, Number.MAX_SAFE_INTEGER - 1),
            invalidInteger("reviewMutationFence", 0, Number.MAX_SAFE_INTEGER - 1),
            invalidBoolean("reviewMutationActive"),
            invalidBoolean("summaryDirty"),
            invalidOptionalStringPattern("reviewMutationToken", UUID_PATTERN),
            invalidOptionalDate("reviewMutationExpiresAt"),
            invalidRunLeaseState(),
            invalidOptionalStringPattern("lockToken", UUID_PATTERN),
            invalidOptionalDate("lockStartedAt"),
            invalidOptionalDate("lockExpiresAt"),
            invalidTokenExpiryPair("lockToken", "lockExpiresAt"),
            invalidOptionalStringPattern(
              "pendingReviewTransition.operationId",
              OPERATION_ID_PATTERN
            ),
            invalidOptionalObjectId("pendingReviewTransition.itemId"),
            invalidOptionalObjectId("pendingReviewTransition.candidatePortalRowId"),
            invalidOptionalObjectId("pendingReviewTransition.actorUserId"),
            invalidOptionalEnum("pendingReviewTransition.action", ["ACCEPT_MATCH", "UNMATCH"]),
            invalidOptionalStringPattern(
              "bulkReviewOperation.operationId",
              OPERATION_ID_PATTERN
            ),
            invalidOptionalEnum("bulkReviewOperation.state", ["PENDING", "COMPLETED"]),
            invalidOptionalObjectId("bulkReviewOperation.actorUserId"),
            invalidOptionalStringPattern(
              "lastCompletedReviewOperationId",
              OPERATION_ID_PATTERN
            ),
          ],
        },
      },
      {
        Model: ReconciliationRun,
        label: "reconciliation runs without valid lock coordination state",
        filter: {
          ...reviewedRunFilter,
          $or: [
            {
              status: "LOCKING",
              $or: [
                invalidStringPattern("lockToken", UUID_PATTERN),
                invalidRequiredType("lockStartedAt", ["date"]),
                invalidRequiredType("lockExpiresAt", ["date"]),
              ],
            },
            {
              status: { $ne: "LOCKING" },
              $or: [
                { lockToken: { $ne: null } },
                { lockStartedAt: { $ne: null } },
                { lockExpiresAt: { $ne: null } },
              ],
            },
          ],
        },
      },
      {
        Model: ReconciliationRun,
        label: "pending reconciliation transitions without immutable command state",
        filter: {
          ...reviewedRunFilter,
          $and: [
            anyPopulated([
              "pendingReviewTransition.operationId",
              "pendingReviewTransition.itemId",
              "pendingReviewTransition.action",
              "pendingReviewTransition.candidatePortalRowId",
              "pendingReviewTransition.expectedDecisionVersion",
              "pendingReviewTransition.actorUserId",
              "pendingReviewTransition.startedAt",
            ]),
            {
              $or: [
                { status: { $ne: "REVIEW" } },
                { summaryDirty: { $ne: true } },
                invalidStringPattern("pendingReviewTransition.operationId", OPERATION_ID_PATTERN),
                invalidObjectId("pendingReviewTransition.itemId"),
                invalidRequiredEnum("pendingReviewTransition.action", ["ACCEPT_MATCH", "UNMATCH"]),
                invalidInteger(
                  "pendingReviewTransition.expectedDecisionVersion",
                  0,
                  Number.MAX_SAFE_INTEGER - 1
                ),
                invalidRequiredType("pendingReviewTransition.payload", ["object"]),
                invalidOptionalObjectId("pendingReviewTransition.payload.ownerUserId"),
                invalidOptionalObjectId("pendingReviewTransition.payload.taskId"),
                invalidOptionalObjectId("pendingReviewTransition.payload.candidatePortalRowId"),
                invalidObjectId("pendingReviewTransition.actorUserId"),
                invalidRequiredType("pendingReviewTransition.startedAt", ["date"]),
                {
                  $expr: {
                    $eq: [
                      {
                        $cond: [
                          { $eq: ["$pendingReviewTransition.action", "ACCEPT_MATCH"] },
                          {
                            $and: [
                              {
                                $eq: [
                                  { $type: "$pendingReviewTransition.candidatePortalRowId" },
                                  "objectId",
                                ],
                              },
                              {
                                $eq: [
                                  "$pendingReviewTransition.candidatePortalRowId",
                                  "$pendingReviewTransition.payload.candidatePortalRowId",
                                ],
                              },
                            ],
                          },
                          {
                            $and: [
                              { $eq: ["$pendingReviewTransition.action", "UNMATCH"] },
                              {
                                $in: [
                                  { $type: "$pendingReviewTransition.candidatePortalRowId" },
                                  ["missing", "null"],
                                ],
                              },
                              {
                                $in: [
                                  { $type: "$pendingReviewTransition.payload.candidatePortalRowId" },
                                  ["missing", "null"],
                                ],
                              },
                            ],
                          },
                        ],
                      },
                      false,
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
      {
        Model: ReconciliationRun,
        label: "bulk reconciliation operations without immutable command state",
        filter: {
          ...reviewedRunFilter,
          $and: [
            anyPopulated([
              "bulkReviewOperation.operationId",
              "bulkReviewOperation.state",
              "bulkReviewOperation.action",
              "bulkReviewOperation.actorUserId",
              "bulkReviewOperation.startedAt",
            ]),
            {
              $or: [
                invalidStringPattern("bulkReviewOperation.operationId", OPERATION_ID_PATTERN),
                invalidRequiredEnum("bulkReviewOperation.state", ["PENDING", "COMPLETED"]),
                invalidRequiredEnum("bulkReviewOperation.action", GST_BULK_ACTIONS),
                invalidStringPattern("bulkReviewOperation.previewToken", SHA256_HEX_PATTERN),
                invalidRequiredType("bulkReviewOperation.payload", ["object"]),
                invalidOptionalObjectId("bulkReviewOperation.payload.ownerUserId"),
                invalidOptionalObjectId("bulkReviewOperation.payload.taskId"),
                invalidOptionalObjectId("bulkReviewOperation.payload.candidatePortalRowId"),
                invalidObjectId("bulkReviewOperation.actorUserId"),
                invalidRequiredType("bulkReviewOperation.itemVersions", ["array"]),
                invalidArrayLength("bulkReviewOperation.itemVersions", 1, 200),
                invalidSubdocumentObjectIdArray(
                  "bulkReviewOperation.itemVersions",
                  "itemId"
                ),
                invalidSubdocumentUniqueArray(
                  "bulkReviewOperation.itemVersions",
                  "itemId"
                ),
                invalidSubdocumentIntegerArray(
                  "bulkReviewOperation.itemVersions",
                  "decisionVersion",
                  0,
                  Number.MAX_SAFE_INTEGER - 1
                ),
                invalidInteger("bulkReviewOperation.affectedCount", 1, 200),
                invalidRequiredType("bulkReviewOperation.startedAt", ["date"]),
                {
                  $expr: {
                    $eq: [
                      {
                        $cond: [
                          { $eq: ["$bulkReviewOperation.state", "PENDING"] },
                          {
                            $and: [
                              { $eq: ["$summaryDirty", true] },
                              {
                                $in: [
                                  { $type: "$bulkReviewOperation.completedAt" },
                                  ["missing", "null"],
                                ],
                              },
                            ],
                          },
                          {
                            $and: [
                              { $eq: ["$bulkReviewOperation.state", "COMPLETED"] },
                              {
                                $eq: [
                                  { $type: "$bulkReviewOperation.completedAt" },
                                  "date",
                                ],
                              },
                            ],
                          },
                        ],
                      },
                      false,
                    ],
                  },
                },
                {
                  $expr: {
                    $eq: [
                      {
                        $cond: [
                          {
                            $eq: [
                              { $type: "$bulkReviewOperation.itemVersions" },
                              "array",
                            ],
                          },
                          {
                            $eq: [
                              "$bulkReviewOperation.affectedCount",
                              { $size: "$bulkReviewOperation.itemVersions" },
                            ],
                          },
                          false,
                        ],
                      },
                      false,
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
      {
        Model: ReconciliationRun,
        label: "reconciliation revisions without typed lineage",
        filter: {
          revision: { $gt: 1 },
          $or: [
            invalidObjectId("rootRunId"),
            invalidObjectId("parentRunId"),
          ],
        },
      },
      {
        Model: ReconciliationItem,
        label: "reconciliation items without typed generation identity",
        filter: {
          $or: [
            invalidObjectId("_id"),
            invalidObjectId("firmId"),
            invalidObjectId("runId"),
            invalidObjectId("clientId"),
            invalidStringPattern("itemKey", NONBLANK_ITEM_KEY_PATTERN),
            invalidBoolean("isActive"),
            invalidOptionalObjectId("booksRowId"),
            invalidOptionalObjectId("portalRowId"),
            invalidOptionalObjectId("retiredPortalRowId"),
            invalidObjectIdArray("candidatePortalRowIds"),
            invalidObjectIdArray("candidateHistoryPortalRowIds"),
            invalidInteger("generationAttempt", 1),
            invalidInteger("decisionVersion", 0, Number.MAX_SAFE_INTEGER - 1),
            invalidInteger("reviewMutationFence", 0, Number.MAX_SAFE_INTEGER - 1),
            invalidOptionalStringPattern("reviewMutationToken", UUID_PATTERN),
            invalidOptionalDate("reviewMutationExpiresAt"),
            invalidTokenExpiryPair("reviewMutationToken", "reviewMutationExpiresAt"),
            invalidOptionalStringPattern("lastReviewOperationId", OPERATION_ID_PATTERN),
            invalidOptionalStringPattern("lastLifecycleOperationId", OPERATION_ID_PATTERN),
            invalidOptionalStringPattern(
              "pendingTransition.operationId",
              OPERATION_ID_PATTERN
            ),
            invalidOptionalEnum("pendingTransition.action", ["ACCEPT_MATCH", "UNMATCH"]),
            invalidOptionalObjectId("pendingTransition.candidatePortalRowId"),
            invalidOptionalObjectId("userDisposition.ownerUserId"),
            invalidOptionalObjectId("userDisposition.updatedBy"),
            invalidOptionalObjectId("taskId"),
          ],
        },
      },
      {
        Model: ReconciliationItem,
        label: "reconciliation items without valid active or tombstone source state",
        filter: {
          $expr: {
            $eq: [
              {
                $cond: [
                  { $eq: ["$isActive", false] },
                  {
                    $and: [
                      { $eq: [{ $type: "$retiredPortalRowId" }, "objectId"] },
                      { $in: [{ $type: "$booksRowId" }, ["missing", "null"]] },
                      { $in: [{ $type: "$portalRowId" }, ["missing", "null"]] },
                    ],
                  },
                  {
                    $and: [
                      {
                        $or: [
                          { $eq: [{ $type: "$booksRowId" }, "objectId"] },
                          { $eq: [{ $type: "$portalRowId" }, "objectId"] },
                        ],
                      },
                      {
                        $in: [
                          { $type: "$retiredPortalRowId" },
                          ["missing", "null"],
                        ],
                      },
                    ],
                  },
                ],
              },
              false,
            ],
          },
        },
      },
      {
        Model: ReconciliationItem,
        label: "pending reconciliation items without typed transition state",
        filter: {
          $and: [
            anyPopulated([
              "pendingTransition.operationId",
              "pendingTransition.action",
              "pendingTransition.candidatePortalRowId",
              "pendingTransition.expectedDecisionVersion",
              "pendingTransition.startedAt",
            ]),
            {
              $or: [
                { isActive: { $ne: true } },
                invalidStringPattern("pendingTransition.operationId", OPERATION_ID_PATTERN),
                invalidRequiredEnum("pendingTransition.action", ["ACCEPT_MATCH", "UNMATCH"]),
                invalidInteger(
                  "pendingTransition.expectedDecisionVersion",
                  0,
                  Number.MAX_SAFE_INTEGER - 1
                ),
                invalidRequiredType("pendingTransition.startedAt", ["date"]),
                {
                  $expr: {
                    $eq: [
                      {
                        $cond: [
                          { $eq: ["$pendingTransition.action", "ACCEPT_MATCH"] },
                          {
                            $eq: [
                              { $type: "$pendingTransition.candidatePortalRowId" },
                              "objectId",
                            ],
                          },
                          {
                            $and: [
                              { $eq: ["$pendingTransition.action", "UNMATCH"] },
                              {
                                $in: [
                                  { $type: "$pendingTransition.candidatePortalRowId" },
                                  ["missing", "null"],
                                ],
                              },
                            ],
                          },
                        ],
                      },
                      false,
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
      {
        Model: ReconciliationItem,
        label: "pending reconciliation items without matching run command",
        verify: async () => {
          const orphan = await ReconciliationItem.aggregate([
            {
              $match: anyPopulated([
                "pendingTransition.operationId",
                "pendingTransition.action",
                "pendingTransition.candidatePortalRowId",
                "pendingTransition.expectedDecisionVersion",
                "pendingTransition.startedAt",
              ]),
            },
            {
              $lookup: {
                from: ReconciliationRun.collection.name,
                let: {
                  itemRunId: "$runId",
                  itemFirmId: "$firmId",
                  itemId: "$_id",
                  generationAttempt: "$generationAttempt",
                  operationId: "$pendingTransition.operationId",
                  action: "$pendingTransition.action",
                  candidatePortalRowId: "$pendingTransition.candidatePortalRowId",
                  expectedDecisionVersion: "$pendingTransition.expectedDecisionVersion",
                },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $and: [
                          { $eq: ["$_id", "$$itemRunId"] },
                          { $eq: ["$firmId", "$$itemFirmId"] },
                          { $eq: ["$status", "REVIEW"] },
                          { $eq: ["$activeGenerationAttempt", "$$generationAttempt"] },
                          { $eq: ["$summaryDirty", true] },
                          {
                            $eq: [
                              "$pendingReviewTransition.operationId",
                              "$$operationId",
                            ],
                          },
                          { $eq: ["$pendingReviewTransition.itemId", "$$itemId"] },
                          { $eq: ["$pendingReviewTransition.action", "$$action"] },
                          {
                            $eq: [
                              {
                                $ifNull: [
                                  "$pendingReviewTransition.candidatePortalRowId",
                                  null,
                                ],
                              },
                              { $ifNull: ["$$candidatePortalRowId", null] },
                            ],
                          },
                          {
                            $eq: [
                              "$pendingReviewTransition.expectedDecisionVersion",
                              "$$expectedDecisionVersion",
                            ],
                          },
                        ],
                      },
                    },
                  },
                  { $limit: 1 },
                ],
                as: "coordinatingRun",
              },
            },
            { $match: { coordinatingRun: { $eq: [] } } },
            { $limit: 1 },
          ]);
          return orphan.length > 0;
        },
      }
    );
  }

  const unsafe = [];
  for (const check of checks) {
    try {
      const unsafeDocument = check.verify
        ? await check.verify()
        : await check.Model.exists(check.filter);
      if (unsafeDocument) unsafe.push(check.label);
    } catch {
      unsafe.push(`${check.label} (verification failed)`);
    }
  }
  return unsafe;
}

export async function assertGstStorageIndexes({ reconciliation = false } = {}) {
  const expectedSpecs = reconciliation
    ? [...IMPORT_INDEX_SPECS, ...RECONCILIATION_INDEX_SPECS]
    : IMPORT_INDEX_SPECS;
  const forbiddenSpecs = reconciliation
    ? FORBIDDEN_INDEX_SPECS
    : FORBIDDEN_INDEX_SPECS.filter((spec) =>
        [ImportBatch, ImportRow].includes(spec.Model)
      );
  const indexesByModel = new Map();
  const unavailableModels = new Set();

  for (const Model of new Set(
    [...expectedSpecs, ...forbiddenSpecs].map((spec) => spec.Model)
  )) {
    try {
      indexesByModel.set(Model, await Model.collection.indexes());
    } catch {
      indexesByModel.set(Model, []);
      unavailableModels.add(Model.modelName);
    }
  }

  const missing = expectedSpecs
    .filter((spec) => !indexesByModel.get(spec.Model).some((index) => indexSpecMatches(index, spec)))
    .map((spec) => `${spec.Model.modelName} (${spec.label})`);
  const forbidden = forbiddenSpecs
    .filter((spec) => indexesByModel.get(spec.Model).some(
      (index) => index.unique === true && indexKeyMatches(index, spec.key)
    ))
    .map((spec) => `${spec.Model.modelName} (${spec.label})`);
  const unsafeDocuments = await findUnsafeLegacyDocuments({ reconciliation });
  const failures = [
    ...missing,
    ...[...unavailableModels].map((name) => `${name} (index verification failed)`),
    ...forbidden.map((label) => `${label} must be removed by approved migration`),
    ...unsafeDocuments.map((label) => `${label} require approved migration`),
  ];

  if (failures.length) {
    const error = new Error(
      `GST storage is not rollout-ready: ${[...new Set(failures)].join(", ")}. Complete the approved storage rollout before committing GST data.`
    );
    error.statusCode = 503;
    error.code = "GST_STORAGE_INDEXES_UNAVAILABLE";
    throw error;
  }
  return true;
}

/**
 * The models whose indexes `assertGstStorageIndexes` requires, in the shape
 * `index-provisioning.service.js` consumes.
 *
 * WHY THIS EXPORT EXISTS
 * ----------------------
 * `db.js` sets `autoIndex: process.env.NODE_ENV !== "production"` -- "index in dev, manage in
 * prod" -- and `index-provisioning.service.js` is what "manage in prod" means. Until this was
 * added, NO group covered ImportBatch, ImportRow or the reconciliation collections, so on a
 * production database that had never had autoIndex build them, every GST import commit answered
 * **503 "GST storage is not rollout-ready: ImportBatch (import identity), ImportRow (import row
 * generation)"** and no reconciliation could ever be created.
 *
 * Reproduced directly rather than reasoned about: the desktop fixture capture runs with
 * NODE_ENV=production against a database it drops on every run, drove the real
 * preview -> commit chain, and got exactly that 503 from
 * `gst-storage-readiness.service.js:1075`.
 *
 * That makes it a latent production defect rather than a visible one: an environment whose
 * collections were first created while autoIndex was on already has these indexes, so the running
 * service is fine. A FRESH deployment -- or a restore into a new cluster, which is exactly what
 * O3/O4's disaster-recovery path does -- would come up with GST import permanently refused.
 *
 * Derived from the same spec arrays the assertion uses, so the two cannot drift apart.
 */
export const REQUIRED_GST_STORAGE_INDEXES = Object.freeze(
  [...IMPORT_INDEX_SPECS, ...RECONCILIATION_INDEX_SPECS].map((spec) => ({
    model: spec.Model,
    label: `GST storage: ${spec.label}`,
  })),
);

export { indexKeyMatches, indexSpecMatches };
