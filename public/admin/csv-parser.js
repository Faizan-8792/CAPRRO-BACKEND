async function parseCSV(file) {
  const text = await file.text();
  const rows = text.split("\n").slice(1);

  let totalDebit = 0;
  let totalCredit = 0;
  let roundFigureCount = 0;

  rows.forEach(r => {
    const [date, debit, credit] = r.split(",");
    const d = Number(debit || 0);
    const c = Number(credit || 0);

    totalDebit += d;
    totalCredit += c;

    if (d % 1000 === 0 || c % 1000 === 0) {
      roundFigureCount++;
    }
  });

  return {
    totalEntries: rows.length,
    totalDebit,
    totalCredit,
    roundFigureCount,
    lastEntryDate: rows[rows.length - 1]?.split(",")[0],
  };
}
