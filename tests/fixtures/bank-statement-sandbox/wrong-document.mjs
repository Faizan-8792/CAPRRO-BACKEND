// A child that answers "accepted" about a document it was not sent. The parent must refuse it.
process.once("message", () => {
  process.send({
    ok: true,
    result: {
      accepted: true,
      status: "READY_FOR_LAYOUT_DETECTION",
      file: { name: "other.pdf", size: 1, sha256: "0".repeat(64), pageCount: 1 },
      pages: [],
    },
  }, () => process.exit(0));
});
