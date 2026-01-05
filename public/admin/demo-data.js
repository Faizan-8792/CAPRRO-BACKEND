// public/admin/demo-data.js
// Frontend-only demo dataset for PENDING firm admins.
// IMPORTANT: This file is never used by backend APIs and must not write to database.

(function () {
  'use strict';

  function daysFromNow(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString();
  }

  const demo = {
    firm: {
      displayName: 'Demo & Co. Chartered Accountants',
      handle: 'demo-firm',
      planType: 'FREE',
      planExpiry: null,
      isDemo: true,
    },

    dashboard: {
      totalUsers: 6,
      activeUsers: 5,
      planType: 'FREE',
      planExpiryLabel: 'Expires NA',
    },

    users: {
      ok: true,
      users: [
        { _id: 'u111111111111111111111111', name: 'Ayesha Khan', email: 'ayesha.demo@example.com', role: 'FIRM_ADMIN', accountType: 'FIRM', isActive: false, createdAt: daysFromNow(-12) },
        { _id: 'u222222222222222222222222', name: 'Rohit Sharma', email: 'rohit.demo@example.com', role: 'USER', accountType: 'FIRM', isActive: true, createdAt: daysFromNow(-40) },
        { _id: 'u333333333333333333333333', name: 'Neha Verma', email: 'neha.demo@example.com', role: 'USER', accountType: 'FIRM', isActive: true, createdAt: daysFromNow(-25) },
        { _id: 'u444444444444444444444444', name: 'Karan Singh', email: 'karan.demo@example.com', role: 'USER', accountType: 'FIRM', isActive: true, createdAt: daysFromNow(-10) },
        { _id: 'u555555555555555555555555', name: 'Fatima Ali', email: 'fatima.demo@example.com', role: 'USER', accountType: 'FIRM', isActive: true, createdAt: daysFromNow(-6) },
        { _id: 'u666666666666666666666666', name: 'Arjun Mehta', email: 'arjun.demo@example.com', role: 'USER', accountType: 'FIRM', isActive: true, createdAt: daysFromNow(-3) },
      ],
    },

    taskBoard: {
      ok: true,
      plan: 'FREE',
      columns: {
        NOT_STARTED: [
          { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', clientName: 'Sample Client A', title: 'ITR Filing FY 24-25', serviceType: 'ITR', dueDateISO: daysFromNow(5), status: 'NOT_STARTED', meta: {} },
          { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', clientName: 'Sample Client B', title: 'GST Return (GSTR-3B)', serviceType: 'GST', dueDateISO: daysFromNow(2), status: 'NOT_STARTED', meta: {} },
          { id: 'abababababababababababab', clientName: 'Sample Client G', title: 'TDS Payment Challan (Jan)', serviceType: 'TDS', dueDateISO: daysFromNow(4), status: 'NOT_STARTED', meta: {}, assignedTo: { email: 'arjun.demo@example.com' } },
          { id: 'bcbcbcbcbcbcbcbcbcbcbcbc', clientName: 'Sample Client H', title: 'GST Registration Amendment', serviceType: 'GST', dueDateISO: daysFromNow(10), status: 'NOT_STARTED', meta: {}, assignedTo: { email: 'rohit.demo@example.com' } },
          { id: 'cdcdcdcdcdcdcdcdcdcdcdcd', clientName: 'Sample Client I', title: 'ROC Board Resolution Filing', serviceType: 'ROC', dueDateISO: daysFromNow(7), status: 'NOT_STARTED', meta: {}, assignedTo: { email: 'karan.demo@example.com' } },
        ],
        WAITING_DOCS: [
          { id: 'cccccccccccccccccccccccc', clientName: 'Sample Client C', title: 'TDS Quarterly Return', serviceType: 'TDS', dueDateISO: daysFromNow(1), status: 'WAITING_DOCS', meta: { waitingSince: daysFromNow(-6), delayReason: 'DOCUMENTS_PENDING' }, assignedTo: { email: 'neha.demo@example.com' } },
          { id: 'dededededededededededede', clientName: 'Sample Client J', title: 'ITR – Capital gains details', serviceType: 'ITR', dueDateISO: daysFromNow(3), status: 'WAITING_DOCS', meta: { waitingSince: daysFromNow(-4), delayReason: 'CLIENT_DELAY' }, assignedTo: { email: 'fatima.demo@example.com' } },
          { id: 'efefefefefefefefefefefef', clientName: 'Sample Client K', title: 'GST – Purchase invoices (missing)', serviceType: 'GST', dueDateISO: daysFromNow(2), status: 'WAITING_DOCS', meta: { waitingSince: daysFromNow(-8), delayReason: 'DOCUMENTS_PENDING' }, assignedTo: { email: 'rohit.demo@example.com' } },
        ],
        IN_PROGRESS: [
          { id: 'dddddddddddddddddddddddd', clientName: 'Sample Client D', title: 'ROC Annual Filing', serviceType: 'ROC', dueDateISO: daysFromNow(8), status: 'IN_PROGRESS', meta: {}, assignedTo: { email: 'rohit.demo@example.com' } },
          { id: 'f0f0f0f0f0f0f0f0f0f0f0f0', clientName: 'Sample Client L', title: 'Audit – Vouching & ledger review', serviceType: 'AUDIT', dueDateISO: daysFromNow(12), status: 'IN_PROGRESS', meta: {}, assignedTo: { email: 'karan.demo@example.com' } },
          { id: 'f1f1f1f1f1f1f1f1f1f1f1f1', clientName: 'Sample Client M', title: 'TDS – Form 26Q preparation', serviceType: 'TDS', dueDateISO: daysFromNow(6), status: 'IN_PROGRESS', meta: {}, assignedTo: { email: 'neha.demo@example.com' } },
        ],
        FILED: [
          { id: 'eeeeeeeeeeeeeeeeeeeeeeee', clientName: 'Sample Client E', title: 'GST Annual Return', serviceType: 'GST', dueDateISO: daysFromNow(-3), status: 'FILED', meta: {}, assignedTo: { email: 'karan.demo@example.com' } },
          { id: 'f2f2f2f2f2f2f2f2f2f2f2f2', clientName: 'Sample Client N', title: 'ITR – Computation & upload', serviceType: 'ITR', dueDateISO: daysFromNow(-1), status: 'FILED', meta: {}, assignedTo: { email: 'fatima.demo@example.com' } },
          { id: 'f3f3f3f3f3f3f3f3f3f3f3f3', clientName: 'Sample Client O', title: 'TDS – TRACES correction', serviceType: 'TDS', dueDateISO: daysFromNow(-10), status: 'FILED', meta: {}, assignedTo: { email: 'arjun.demo@example.com' } },
        ],
        CLOSED: [
          { id: 'ffffffffffffffffffffffff', clientName: 'Sample Client F', title: 'Client Onboarding', serviceType: 'Onboarding', dueDateISO: daysFromNow(-30), status: 'CLOSED', meta: {}, assignedTo: { email: 'fatima.demo@example.com' } },
          { id: '010101010101010101010101', clientName: 'Sample Client P', title: 'GST – Initial setup & checklist', serviceType: 'GST', dueDateISO: daysFromNow(-20), status: 'CLOSED', meta: {}, assignedTo: { email: 'rohit.demo@example.com' } },
          { id: '020202020202020202020202', clientName: 'Sample Client Q', title: 'ROC – DIN KYC completed', serviceType: 'ROC', dueDateISO: daysFromNow(-15), status: 'CLOSED', meta: {}, assignedTo: { email: 'karan.demo@example.com' } },
        ],
      },
    },

    productivity: {
      ok: true,
      data: [
        { label: 'Neha', tasksCompleted: 14 },
        { label: 'Rohit', tasksCompleted: 11 },
        { label: 'Karan', tasksCompleted: 9 },
        { label: 'Fatima', tasksCompleted: 7 },
        { label: 'Arjun', tasksCompleted: 5 },
      ],
    },

    remindersToday: {
      ok: true,
      reminders: [
        { typeId: 'GST', clientLabel: 'Sample Client B', status: 'PENDING', dueDateISO: daysFromNow(1) },
        { typeId: 'TDS', clientLabel: 'Sample Client C', status: 'PENDING', dueDateISO: daysFromNow(1) },
      ]
    },

    clientsToChaseToday: {
      ok: true,
      pendingDocsClients: [
        { taskId: 'cccccccccccccccccccccccc', clientName: 'Sample Client C', serviceType: 'TDS', daysPending: 6, dueDateISO: daysFromNow(1) },
      ],
      chronicLateClients: [
        { taskId: 'bbbbbbbbbbbbbbbbbbbbbbbb', clientName: 'Sample Client B', serviceType: 'GST', lastPeriodDelayDays: 4, dueDateISO: daysFromNow(2) },
      ],
    },

    documentRequests: {
      ok: true,
      data: [
        {
          _id: '111111111111111111111111',
          clientId: 'Sample Client A',
          clientName: 'Sample Client A',
          status: 'REQUESTED',
          createdAt: daysFromNow(-2),
          items: [
            { key: 'BANK_STATEMENT', label: 'Bank statement', status: 'PENDING' },
            { key: 'FORM_16', label: 'Form 16', status: 'PENDING' },
          ],
        },
        {
          _id: '222222222222222222222222',
          clientId: 'Sample Client C',
          clientName: 'Sample Client C',
          status: 'INCOMPLETE',
          createdAt: daysFromNow(-7),
          items: [
            { key: 'SALES_INVOICES', label: 'Sales invoices', status: 'RECEIVED' },
            { key: 'PURCHASE_INVOICES', label: 'Purchase invoices', status: 'PENDING' },
          ],
        },
      ],
    },

    pendingDocsSummary: {
      ok: true,
      counts: { PENDING: 3, RECEIVED: 1 },
      recent: [
        { clientId: 'Sample Client A', clientName: 'Sample Client A', createdAt: daysFromNow(-2) },
        { clientId: 'Sample Client C', clientName: 'Sample Client C', createdAt: daysFromNow(-7) },
      ],
    },

    delayLogsAggregate: {
      ok: true,
      aggregate: [
        { _id: 'DOCUMENTS_PENDING', count: 4 },
        { _id: 'CLIENT_DELAY', count: 2 },
        { _id: 'STAFF_WORKLOAD', count: 1 },
      ],
      recent: [
        { _id: '333333333333333333333333', taskId: 'cccccccccccccccccccccccc', reason: 'DOCUMENTS_PENDING', createdAt: daysFromNow(-1) },
        { _id: '444444444444444444444444', taskId: 'bbbbbbbbbbbbbbbbbbbbbbbb', reason: 'CLIENT_DELAY', createdAt: daysFromNow(-3) },
      ],
    },
  };

  window.caproDemoData = demo;
})();
