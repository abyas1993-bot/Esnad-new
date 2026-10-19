import assert from "node:assert/strict";
import test from "node:test";

import {
  createBackupFile,
  createBackupFileName,
  parseBackupFileJson,
  restoreBackupData,
  validateBackupFile,
} from "../src/backup.ts";
import type { FullDataSnapshot } from "../src/storage.ts";

const exportedAt = "2026-10-20T11:22:33.000Z";
const snapshot: FullDataSnapshot = {
  accounts: [
    { id: "income", name: "دخل", category: "income_source", openingBalance: 0, status: "active" },
    { id: "expense", name: "مصروف", category: "expense", openingBalance: 0, status: "active" },
    { id: "pot", name: "وعاء", category: "pot", openingBalance: 100, status: "active" },
  ],
  journalEntries: [
    {
      id: "entry-1",
      entryDate: "2026-10-20",
      transactionType: "direct_entry",
      description: "شراء",
      periodId: "period-1",
      lines: [
        { accountId: "expense", direction: "DEBIT", amount: 20 },
        { accountId: "pot", direction: "CREDIT", amount: 20 },
      ],
    },
  ],
  periods: [{ id: "period-1", startDate: "2026-10-01", endDate: "2026-12-31", status: "open" }],
  periodCloseResults: [],
  planningSettings: [
    { kind: "expense", accountId: "expense", monthlyMin: 0, monthlyMax: 150, priority: "essential" },
  ],
  currencies: [{ code: "SAR", name: "ريال سعودي", symbol: "ر.س" }],
  accountCurrencyLinks: [{ accountId: "pot", currencyCode: "SAR" }],
};

function makeBackup() {
  return createBackupFile(snapshot, { financialPeriodDuration: 3 }, exportedAt);
}

test("exports all local data collections, app settings, and a dated filename", () => {
  const backup = makeBackup();
  assert.equal(backup.schemaVersion, 1);
  assert.equal(backup.exportedAt, exportedAt);
  assert.deepEqual(backup.data, snapshot);
  assert.deepEqual(backup.appSettings, { financialPeriodDuration: 3 });
  assert.equal(createBackupFileName(exportedAt), "إسناد-نسخة-احتياطية-2026-10-20_11-22-33Z.json");
  assert.deepEqual(parseBackupFileJson(JSON.stringify(backup)), backup);
});

test("legacy backups without app settings remain valid", () => {
  const { appSettings: _ignored, ...legacyBackup } = makeBackup();
  const restored = validateBackupFile(legacyBackup);
  assert.equal(restored.appSettings, undefined);
  assert.deepEqual(restored.data, snapshot);
});

test("rejects malformed JSON, missing required stores, incompatible versions, and invalid settings", () => {
  assert.throws(() => parseBackupFileJson("{"), /JSON صالح/);

  const missingStore = makeBackup() as unknown as Record<string, unknown>;
  missingStore.data = { ...snapshot, currencies: undefined };
  assert.throws(() => validateBackupFile(missingStore), /data\.currencies/);

  const wrongVersion = { ...makeBackup(), schemaVersion: 99 };
  assert.throws(() => validateBackupFile(wrongVersion), /غير متوافق/);

  const invalidSettings = { ...makeBackup(), appSettings: { financialPeriodDuration: 4 } };
  assert.throws(() => validateBackupFile(invalidSettings), /مدة فترة مالية غير صالحة/);
});

test("rejects unbalanced, duplicate, and dangling records before any restore write", async () => {
  const unbalanced = makeBackup();
  unbalanced.data.journalEntries[0].lines[1].amount = 19;
  assert.throws(() => validateBackupFile(unbalanced), /غير صالح البنية/);

  const duplicate = makeBackup();
  duplicate.data.accounts.push({ ...duplicate.data.accounts[0] });
  assert.throws(() => validateBackupFile(duplicate), /مكررة/);

  const dangling = makeBackup();
  dangling.data.journalEntries[0].periodId = "missing-period";
  assert.throws(() => validateBackupFile(dangling), /فترة أو حساب غير موجود/);

  let writes = 0;
  await assert.rejects(
    restoreBackupData(unbalanced, async () => {
      writes += 1;
    }),
  );
  assert.equal(writes, 0);
});

test("propagates storage failures instead of reporting a successful restore", async () => {
  const originalData = snapshot;
  let currentData = originalData;
  await assert.rejects(
    restoreBackupData(makeBackup(), async () => {
      throw new Error("write transaction failed");
    }),
    /write transaction failed/,
  );
  assert.equal(currentData, originalData);

  const restored = await restoreBackupData(makeBackup(), async (data) => {
    currentData = data;
  });
  assert.deepEqual(currentData, snapshot);
  assert.equal(restored.appSettings?.financialPeriodDuration, 3);
});
