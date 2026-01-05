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

    taskBoard: {
      ok: true,
      plan: 'FREE',
      columns: {
        NOT_STARTED: [
          { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', clientName: 'Sample Client A', title: 'ITR Filing FY 24-25', dueDateISO: daysFromNow(5), status: 'NOT_STARTED', meta: {} },
          { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', clientName: 'Sample Client B', title: 'GST Return (GSTR-3B)', dueDateISO: daysFromNow(2), status: 'NOT_STARTED', meta: {} },
        ],
        WAITING_DOCS: [
          { id: 'cccccccccccccccccccccccc', clientName: 'Sample Client C', title: 'TDS Quarterly Return', dueDateISO: daysFromNow(1), status: 'WAITING_DOCS', meta: { waitingSince: daysFromNow(-6) } },
        ],
        IN_PROGRESS: [
          { id: 'dddddddddddddddddddddddd', clientName: 'Sample Client D', title: 'ROC Annual Filing', dueDateISO: daysFromNow(8), status: 'IN_PROGRESS', meta: {} },
        ],
        FILED: [
          { id: 'eeeeeeeeeeeeeeeeeeeeeeee', clientName: 'Sample Client E', title: 'GST Annual Return', dueDateISO: daysFromNow(-3), status: 'FILED', meta: {} },
        ],
        CLOSED: [
          { id: 'ffffffffffffffffffffffff', clientName: 'Sample Client F', title: 'Client Onboarding', dueDateISO: daysFromNow(-30), status: 'CLOSED', meta: {} },
        ],
      },
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
