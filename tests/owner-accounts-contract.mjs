// tests/owner-accounts-contract.mjs
//
// DS43 (2026-10-14): the owner's own accounts are left out of every super-admin report. The owner
// tests the product with several accounts (saifullah, faizan, highcustom, highprice, wbrobotics,
// wbmatata), and every report counted them, so none described real customers.
//
// Seeds owner-matching and ordinary accounts, each with the data a report reads - firms, tasks,
// reminders, memberships, usage, paid-provider calls, emails, terms acceptances, sign-in events -
// and proves that each report counts and lists only the ordinary ones, that ?includeOwn=1 brings
// the owner's back, and that every report says what it left out. Nothing is deleted: the owner's
// rows are all still there at the end. Fails on the code before DS43, which counted everyone.
//
// Calls the controllers directly on scratch Mongo (loopback and scratch-marked, or it refuses).

import crypto from "node:crypto";

const uri = process.env.MONGODB_URI || "";
function isLoopbackScratch(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    return (host === "127.0.0.1" || host === "localhost" || host === "::1") && parsed.pathname.toLowerCase().includes("scratch");
  } catch {
    return false;
  }
}

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const SUPER_EMAIL = "saifullahfaizan786@gmail.com";

async function runSuite() {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "owner-accounts-contract-only-not-a-real-secret";
  delete process.env.OWNER_ACCOUNT_PATTERNS;

  const mongoose = (await import("mongoose")).default;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();

  const { default: User } = await import("../src/models/User.js");
  const { default: Firm } = await import("../src/models/Firm.js");
  const { default: Task } = await import("../src/models/Task.js");
  const { default: Reminder } = await import("../src/models/Reminder.js");
  const { default: FirmMembership } = await import("../src/models/FirmMembership.js");
  const { default: WorkflowUsage } = await import("../src/models/WorkflowUsage.js");
  const { default: ProviderUsage, GLOBAL_USAGE_USER_ID, dailyPeriodKey, monthlyPeriodKey } = await import("../src/models/ProviderUsage.js");
  const { default: EmailDelivery } = await import("../src/models/EmailDelivery.js");
  const { default: TermsAcceptance } = await import("../src/models/TermsAcceptance.js");
  const { default: AuthHealthEvent } = await import("../src/models/AuthHealthEvent.js");
  const superController = await import("../src/controllers/super.controller.js");
  const { listTermsAcceptances } = await import("../src/controllers/terms.controller.js");
  const { getAuthHealth } = await import("../src/controllers/auth-health.controller.js");

  let owners = null;
  try {
    owners = await import("../src/services/owner-accounts.service.js");
  } catch {
    owners = null;
  }

  try {
    // ---- 1. The rule (pure). ----
    check("owner-accounts.service.js exists", Boolean(owners));
    if (owners) {
      const { isOwnerEmail, ownerAccountPatterns } = owners;
      check("the owner's six patterns are the default list",
        JSON.stringify(ownerAccountPatterns({})) === JSON.stringify(["saifullah", "faizan", "highcustom", "highprice", "wbrobotics", "wbmatata"]));
      check("dots, hyphens and case are ignored: wb.robotics, High-Custom, FAIZAN",
        isOwnerEmail("wb.robotics.qa@example.invalid") && isOwnerEmail("High-Custom.Tester@example.invalid") && isOwnerEmail("FAIZAN.X@EXAMPLE.INVALID"));
      check("a pattern never straddles the @: high@price.example is not the owner's", !isOwnerEmail("high@price.example"));
      check("an ordinary address is not the owner's", !isOwnerEmail("ordinary.client@example.invalid"));
      check("OWNER_ACCOUNT_PATTERNS replaces the list, and a pattern under four letters is ignored",
        JSON.stringify(ownerAccountPatterns({ OWNER_ACCOUNT_PATTERNS: "abc, Long.Name " })) === JSON.stringify(["longname"]));
    }

    // ---- 2. Seed: three owner accounts, two ordinary ones, each with data. ----
    const now = new Date();
    const superAdmin = await User.create({ email: SUPER_EMAIL, name: "Owner", role: "SUPER_ADMIN", accountType: "INDIVIDUAL", isActive: true, lastActiveAt: now, totalApiCalls: 50 });
    const ownerB = await User.create({ email: "wb.robotics.qa@example.invalid", name: "Owner B", role: "USER", accountType: "INDIVIDUAL", isActive: true, lastActiveAt: now, totalApiCalls: 40, firmAdminRequestedAt: now });
    const ownerC = await User.create({ email: "high-custom.tester@example.invalid", name: "Owner C", role: "USER", accountType: "INDIVIDUAL", isActive: true, lastActiveAt: now, totalApiCalls: 35 });
    const ordinaryA = await User.create({ email: "ordinary.client@example.invalid", name: "Client A", role: "USER", accountType: "INDIVIDUAL", isActive: true, lastActiveAt: now, totalApiCalls: 30, firmAdminRequestedAt: now });
    const ordinaryB = await User.create({ email: "high@price.example", name: "Client B", role: "USER", accountType: "INDIVIDUAL", isActive: true, lastActiveAt: now, totalApiCalls: 20 });
    const ownerEmails = [superAdmin, ownerB, ownerC].map((u) => u.email);
    const ordinaryEmails = [ordinaryA, ordinaryB].map((u) => u.email);

    const ownerFirm = new mongoose.Types.ObjectId();
    const ordinaryFirm = new mongoose.Types.ObjectId();
    await Firm.collection.insertMany([
      { _id: ownerFirm, displayName: "Owner Test Firm", handle: "owner-test", joinCode: "OWNERTEST01", ownerUserId: ownerB._id, kind: "SHARED", isActive: true, createdAt: now, updatedAt: now },
      { _id: ordinaryFirm, displayName: "Client Firm", handle: "client-firm", joinCode: "CLIENTFIRM1", ownerUserId: ordinaryA._id, kind: "SHARED", isActive: true, createdAt: now, updatedAt: now },
    ]);
    await Task.collection.insertMany([
      { firmId: ownerFirm, createdBy: ownerB._id, title: "Owner task", serviceType: "GST", status: "OPEN", isActive: true, createdAt: now },
      { firmId: ordinaryFirm, createdBy: ownerC._id, title: "Owner's task in a client firm", serviceType: "TDS", status: "OPEN", isActive: true, createdAt: now },
      { firmId: ordinaryFirm, createdBy: ordinaryA._id, title: "Client task", serviceType: "GST", status: "OPEN", isActive: true, createdAt: now },
    ]);
    const failing = { v1_offset_m1: { status: "FAILED", scheduleVersion: 1, attemptCount: 5 } };
    await Reminder.collection.insertMany([
      { userId: ownerB._id, firmId: ownerFirm, typeId: "GSTR3B", clientLabel: "Owner", dueDateISO: "2026-10-20", scheduleVersion: 1, isActive: true, deliveryAttempts: failing },
      { userId: ordinaryA._id, firmId: ordinaryFirm, typeId: "GSTR3B", clientLabel: "Client", dueDateISO: "2026-10-21", scheduleVersion: 1, isActive: true, deliveryAttempts: failing },
    ]);
    await FirmMembership.collection.insertMany([
      { firmId: ownerFirm, userId: ownerB._id, role: "OWNER", status: "ACTIVE" },
      { firmId: ownerFirm, userId: ownerC._id, role: "MEMBER", status: "ACTIVE" },
      { firmId: ordinaryFirm, userId: ordinaryA._id, role: "OWNER", status: "ACTIVE" },
      { firmId: ordinaryFirm, userId: ordinaryB._id, role: "MEMBER", status: "ACTIVE" },
    ]);
    await WorkflowUsage.recordUsage({ userId: ownerB._id, firmId: ownerFirm, client: "desktop", workflow: "gst_recon", outcome: "ok" });
    await WorkflowUsage.recordUsage({ userId: ordinaryA._id, firmId: ordinaryFirm, client: "extension", workflow: "import", outcome: "ok" });
    const day = dailyPeriodKey();
    const month = monthlyPeriodKey();
    await ProviderUsage.collection.insertMany([
      { userId: ownerB._id, provider: "DEEPSEEK", periodKey: day, calls: 7 },
      { userId: ordinaryA._id, provider: "DEEPSEEK", periodKey: day, calls: 3 },
      { userId: ownerB._id, provider: "DEEPSEEK", periodKey: month, calls: 70 },
      { userId: ordinaryA._id, provider: "DEEPSEEK", periodKey: month, calls: 30 },
      { userId: GLOBAL_USAGE_USER_ID, provider: "DEEPSEEK", periodKey: day, calls: 10 },
    ]);
    const mail = (extra) => ({ type: "reminder", subjectTemplateName: "compliance_reminder", status: "delivered", errorClass: "none", sentAt: now, createdAt: now, ...extra });
    await EmailDelivery.collection.insertMany([
      mail({ userId: ownerB._id, recipientEmailHash: sha256(ownerB.email), recipientEmailLast4: "alid" }),
      mail({ userId: null, recipientEmailHash: sha256(SUPER_EMAIL), recipientEmailLast4: ".com", type: "otp", subjectTemplateName: "otp_code" }),
      mail({ userId: null, firmId: ownerFirm, recipientEmailHash: sha256("invitee@example.invalid"), recipientEmailLast4: "alid" }),
      mail({ userId: ordinaryA._id, firmId: ordinaryFirm, recipientEmailHash: sha256(ordinaryA.email), recipientEmailLast4: "alid" }),
    ]);
    const terms = (user) => ({ userId: user._id, email: user.email, termsVersion: "2026-09-04", documentHash: "a".repeat(64), accepted: true, source: "DESKTOP", acceptedAt: now, createdAt: now });
    await TermsAcceptance.collection.insertMany([terms(ownerB), terms(ordinaryA)]);
    await AuthHealthEvent.insertMany([
      { kind: "login_success", platform: "extension", userId: ownerB._id, count: 4 },
      { kind: "login_success", platform: "desktop", userId: superAdmin._id, count: 2 },
      { kind: "login_success", platform: "extension", userId: ordinaryA._id, count: 1 },
      { kind: "login_fail", reason: "invalid", platform: "unknown", userId: null, count: 3 },
    ]);
    const ownRowsBefore = await Promise.all([User, Firm, Task, Reminder, EmailDelivery, TermsAcceptance].map((model) => model.countDocuments({})));

    // ---- 3. Each report, without and with the owner's accounts. ----
    const asSuper = { id: String(superAdmin._id), role: "SUPER_ADMIN", email: SUPER_EMAIL };
    async function report(handler, query = {}) {
      let status = 200;
      let body = null;
      const res = {
        status(code) { status = code; return this; },
        json(value) { body = value; return this; },
      };
      await handler({ user: asSuper, query, params: {} }, res, (err) => {
        status = err?.statusCode || 500;
        body = { ok: false, error: String(err?.message || err) };
      });
      return { status, body };
    }
    const both = async (handler, query = {}) => [await report(handler, query), await report(handler, { ...query, includeOwn: "1" })];
    const mentionsOwner = (value) => ownerEmails.some((email) => JSON.stringify(value ?? null).includes(email));
    const noteIsHonest = (body, included) =>
      body?.ownAccounts?.included === included &&
      body?.ownAccounts?.count === 3 &&
      ownerEmails.every((email) => body.ownAccounts.emails?.includes(email)) &&
      !ordinaryEmails.some((email) => body.ownAccounts.emails?.includes(email));

    const [dash, dashAll] = await both(superController.getSuperDashboardStats);
    const stats = dash.body?.stats;
    check("Platform overview: users, active, pending and new sign-ups count only the ordinary accounts",
      stats?.users?.total === 2 && stats.users.active === 2 && stats.users.pendingAdmins === 1 && stats.users.recentSignups === 2,
      JSON.stringify(stats?.users));
    check("Platform overview: firms, tasks, reminders and memberships leave out the owner's",
      stats?.firms?.total === 1 && stats.tasks?.total === 1 && stats.reminders?.total === 1 &&
        stats.collaboration?.memberships === 2 && stats.collaboration?.collaboratingFirms === 1,
      JSON.stringify({ firms: stats?.firms?.total, tasks: stats?.tasks?.total, reminders: stats?.reminders?.total, collaboration: stats?.collaboration }));
    check("Platform overview: says it left out the owner's three accounts, by address", noteIsHonest(dash.body, false));
    check("Platform overview with includeOwn=1 counts everyone again",
      dashAll.body?.stats?.users?.total === 5 && dashAll.body.stats.firms.total === 2 && dashAll.body.stats.tasks.total === 3 &&
        dashAll.body.stats.reminders.total === 2 && noteIsHonest(dashAll.body, true));

    const [usage, usageAll] = await both(superController.getUsageStats);
    const u = usage.body?.usage;
    check("Usage analytics: active users and totals count only the ordinary accounts",
      u?.dau === 2 && u.totalUsers === 2 && u.totalEverActive === 2 && u.totalApiCalls === 50, JSON.stringify({ dau: u?.dau, totalUsers: u?.totalUsers, calls: u?.totalApiCalls }));
    check("Usage analytics: top users, the per-user table and the app split list no owner account",
      !mentionsOwner(u?.topUsers) && !mentionsOwner(u?.perUser) && u?.perUser?.length === 1 &&
        u.clientSplit?.monthly?.desktop === 0 && u.clientSplit?.monthly?.extension === 1,
      JSON.stringify(u?.clientSplit?.monthly));
    check("Usage analytics with includeOwn=1 counts everyone",
      usageAll.body?.usage?.totalUsers === 5 && usageAll.body.usage.perUser.length === 2 && noteIsHonest(usageAll.body, true));

    const [provider, providerAll] = await both(superController.getProviderUsageStats);
    check("Provider usage: today's and this month's calls leave out the owner's (and never the cap's own row)",
      provider.body?.usage?.today?.DEEPSEEK === 3 && provider.body.usage.thisMonth.DEEPSEEK === 30 && !mentionsOwner(provider.body.usage.topUsersToday),
      JSON.stringify(provider.body?.usage));
    check("Provider usage with includeOwn=1 counts the owner's calls, still not the cap's row",
      providerAll.body?.usage?.today?.DEEPSEEK === 10 && providerAll.body.usage.thisMonth.DEEPSEEK === 100);

    const [delivery, deliveryAll] = await both(superController.getReminderDeliveryHealthStats);
    check("Reminder delivery health: only the ordinary account's failing reminder",
      delivery.body?.delivery?.issueCount === 1 && deliveryAll.body?.delivery?.issueCount === 2,
      `${delivery.body?.delivery?.issueCount} / ${deliveryAll.body?.delivery?.issueCount}`);

    const [users, usersAll] = await both(superController.listAllUsers);
    check("User directory: lists only the ordinary accounts",
      users.body?.pagination?.total === 2 && !mentionsOwner(users.body?.users) && noteIsHonest(users.body, false),
      JSON.stringify(users.body?.users?.map((row) => row.email)));
    check("User directory with includeOwn=1 lists all five", usersAll.body?.pagination?.total === 5);
    const [search] = await both(superController.listAllUsers, { search: "robotics" });
    check("a search for an owner account finds nothing until it is included", search.body?.pagination?.total === 0);

    const [pending, pendingAll] = await both(superController.listPendingAdmins);
    check("Pending approvals: only the ordinary account's request",
      pending.body?.users?.length === 1 && pending.body.users[0].email === ordinaryA.email && pendingAll.body?.users?.length === 2);

    const [firms, firmsAll] = await both(superController.listFirms);
    check("Firms: the firm an owner account owns is left out",
      firms.body?.totalFirms === 1 && firms.body.firms[0]?.displayName === "Client Firm" && firmsAll.body?.totalFirms === 2);

    const [emails, emailsAll] = await both(superController.listEmailDeliveriesForSuper);
    check("Emails: mail to, from or in the firms of the owner's accounts is left out",
      emails.body?.total === 1 && String(emails.body.emails?.[0]?.userId) === String(ordinaryA._id) && emails.body.summary?.delivered === 1,
      `total ${emails.body?.total}`);
    check("Emails with includeOwn=1 lists all four", emailsAll.body?.total === 4);
    const [ownSearch] = await both(superController.listEmailDeliveriesForSuper, { recipientHash: sha256(SUPER_EMAIL) });
    check("an exact search for the owner's address finds nothing until it is included", ownSearch.body?.total === 0);
    const [firmSearch] = await both(superController.listEmailDeliveriesForSuper, { firmId: String(ordinaryFirm) });
    check("a firm filter still narrows within the ordinary mail (list and summary agree)",
      firmSearch.body?.total === 1 && firmSearch.body.summary?.delivered === 1, JSON.stringify(firmSearch.body?.summary));

    const [acceptances, acceptancesAll] = await both(listTermsAcceptances);
    check("Terms acceptance: only the ordinary account's acceptance",
      acceptances.body?.pagination?.total === 1 && acceptances.body.acceptances[0]?.email === ordinaryA.email && acceptancesAll.body?.pagination?.total === 2);

    const [health, healthAll] = await both(getAuthHealth, { days: "7" });
    check("Sign-in health: the owner's sign-ins are left out; a failure with no account stays in",
      health.body?.totals?.login_success === 1 && health.body.totals.login_fail === 3 && noteIsHonest(health.body, false),
      JSON.stringify(health.body?.totals));
    check("Sign-in health with includeOwn=1 counts the owner's sign-ins", healthAll.body?.totals?.login_success === 7);

    // ---- 4. Nothing was deleted or changed. ----
    const ownRowsAfter = await Promise.all([User, Firm, Task, Reminder, EmailDelivery, TermsAcceptance].map((model) => model.countDocuments({})));
    check("no row was deleted or added by any report", JSON.stringify(ownRowsBefore) === JSON.stringify(ownRowsAfter), `${ownRowsBefore} -> ${ownRowsAfter}`);
  } finally {
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }

  console.log(`\nOwner accounts contract: ${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

if (!isLoopbackScratch(uri)) {
  console.error("Refusing to run: MONGODB_URI must be a loopback scratch database.");
  process.exitCode = 1;
} else {
  process.exitCode = await runSuite();
}
