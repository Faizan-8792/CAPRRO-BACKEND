// Seed Accounting Intelligence demo records for a specific user email.
// Usage:
//   node scripts/seed-accounting.js --email saifullahfaizan786@gmail.com
// Requires: MONGODB_URI in environment.

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import User from '../src/models/User.js';
import Firm from '../src/models/Firm.js';
import AccountingRecord from '../src/models/AccountingRecord.js';

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function main() {
  // Load .env if present (matches backend config)
  dotenv.config();

  const emailRaw = getArg('email') || 'saifullahfaizan786@gmail.com';
  const email = String(emailRaw).trim().toLowerCase();

  const uri = mustGetEnv('MONGODB_URI');

  await mongoose.connect(uri, { autoIndex: true });

  // 1) Ensure user exists
  let user = await User.findOne({ email });
  if (!user) {
    user = await User.create({
      email,
      name: 'Saifullah (Seed)',
      role: 'FIRM_ADMIN',
      accountType: 'FIRM_USER',
      isActive: true,
    });
  }

  // 2) Ensure firm exists and user is linked
  let firm = null;
  if (user.firmId) {
    firm = await Firm.findById(user.firmId);
  }

  if (!firm) {
    const handleBase = 'saifullah-firm';

    // ensure unique handle/joinCode
    let handle = handleBase;
    let suffix = 1;
    while (await Firm.findOne({ handle })) {
      suffix += 1;
      handle = `${handleBase}${suffix}`;
    }

    const genJoinCode = () => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = '';
      for (let i = 0; i < 6; i += 1) code += chars[Math.floor(Math.random() * chars.length)];
      return code;
    };

    let joinCode = genJoinCode();
    while (await Firm.findOne({ joinCode })) {
      joinCode = genJoinCode();
    }

    firm = await Firm.create({
      displayName: 'Saifullah & Co',
      handle,
      ownerUserId: user._id,
      description: 'Seeded firm for Accounting Intelligence testing',
      practiceAreas: ['GST', 'ITR', 'TDS', 'ROC', 'Audit'],
      joinCode,
      planType: 'PREMIUM',
      planExpiry: addDays(new Date(), 365),
      isActive: true,
    });

    user.firmId = firm._id;
    user.role = 'FIRM_ADMIN';
    user.accountType = 'FIRM_USER';
    user.isActive = true;
    await user.save();
  }

  // 3) Insert a few accounting snapshots
  const expiresAt = addDays(new Date(), 60);

  const records = [
    {
      firmId: firm._id,
      createdBy: user._id,
      clientName: 'ABC Traders',
      periodKey: '2025-12',
      source: 'MANUAL',
      totalEntries: 385,
      totalDebit: 1254300,
      totalCredit: 1254300,
      roundFigureCount: 28,
      lastEntryDate: '2025-12-31',
      health: 'AMBER',
      readinessScore: 74,
      riskFlags: ['Many round-figure entries', 'High month-end concentration'],
      summaryNotes: 'Books are mostly monthly but month-end entries are high. Ask for supporting invoices for top 10 vouchers.',
      conclusion: 'Proceed with routine checks + expanded vouching for month-end entries.',
      expiresAt,
      meta: { seeded: true },
    },
    {
      firmId: firm._id,
      createdBy: user._id,
      clientName: 'Zenith Services Pvt Ltd',
      periodKey: 'FY2025-26',
      source: 'CSV',
      totalEntries: 2140,
      totalDebit: 8942000,
      totalCredit: 8942000,
      roundFigureCount: 310,
      lastEntryDate: '2025-10-15',
      health: 'RED',
      readinessScore: 52,
      riskFlags: ['Unusual spike in round figures', 'Old last entry date'],
      summaryNotes: 'Last entry is old for a running FY. Possible backlog posting. Confirm bank reconciliation and GST return status.',
      conclusion: 'Treat as high-risk. Recommend quick clean-up before audit planning.',
      csvExtractionMeta: {
        extractionConfidence: 0.92,
        fileName: 'ledger-export.csv',
      },
      expiresAt,
      meta: { seeded: true },
    },
    {
      firmId: firm._id,
      createdBy: user._id,
      clientName: 'Omkar Manufactures',
      periodKey: '2025-Q3',
      source: 'MANUAL',
      totalEntries: 640,
      totalDebit: 3425000,
      totalCredit: 3425000,
      roundFigureCount: 44,
      lastEntryDate: '2025-09-30',
      health: 'GREEN',
      readinessScore: 88,
      riskFlags: [''],
      summaryNotes: 'Entries look consistent. No major red flags. Keep an eye on cash payments if any.',
      conclusion: 'Low risk. Standard compliance checks should be sufficient.',
      expiresAt,
      meta: { seeded: true },
    },
  ];

  // remove empty risk flags
  for (const r of records) {
    r.riskFlags = (r.riskFlags || []).filter(Boolean);
  }

  const inserted = await AccountingRecord.insertMany(records);

  console.log('✅ Seed complete');
  console.log(`User: ${user.email} (${user._id})`);
  console.log(`Firm: ${firm.displayName} @${firm.handle} (${firm._id})`);
  console.log(`Inserted accounting records: ${inserted.length}`);

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌ Seed failed:', e);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
