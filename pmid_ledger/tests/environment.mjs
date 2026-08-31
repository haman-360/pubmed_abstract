import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
export function environment(opts = {}) {
  const ctx = vm.createContext({});
  vm.runInContext(
    fs.readFileSync(new URL("../gas/Code.gs", import.meta.url), "utf8"),
    ctx,
  );
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const tables = Object.fromEntries(
    Object.entries(plain(ctx.Ledger.headers)).map(([k, v]) => [k, [v]]),
  );
  tables.Settings.push(
    ["schema", "PMID_LEDGER_V1"],
    ["instance", "test-ledger"],
    ["synced_at", "2026-08-30"],
    ["revision", "one"],
  );
  tables.Papers.push(
    [
      "1",
      "<img src=x>",
      "Journal",
      "2026",
      "https://pubmed.ncbi.nlm.nih.gov/1/",
      "",
      '["感染症"]',
      "2026-08-20",
      "2026-08-29",
      '["test"]',
    ],
    [
      "10",
      "Old paper",
      "",
      "2026",
      "https://pubmed.ncbi.nlm.nih.gov/10/",
      "",
      '["腎臓"]',
      "2026-01-01",
      "2026-01-01",
      '["test"]',
    ],
  );
  tables.Appearances.push(
    [
      "s1",
      "1",
      "issue1",
      "感染症",
      "2026-08-20",
      "Old title",
      "selected",
      "",
      "test",
      "t1",
    ],
    [
      "s2",
      "1",
      "issue2",
      "腎臓",
      "2026-01-01",
      "Other title",
      "candidate",
      "",
      "test",
      "t2",
    ],
  );
  tables.Texts.push(
    ["t1", "0", JSON.stringify({ summary_ja: "保存済み日本語要約" })],
    ["t2", "0", JSON.stringify({ one_line_assessment: "一行評価" })],
  );
  let writes = 0;
  const sheet = (name) =>
    !tables[name]
      ? null
      : {
          getLastRow: () => tables[name].length,
          getMaxRows: () => 10000,
          insertRowsAfter() {},
          setFrozenRows() {},
          getRange: (r, c, nr, nc) => {
            const range = {
              getDisplayValues: () => {
                if (opts.onRead) opts.onRead(name, tables);
                return tables[name]
                  .slice(r - 1, r - 1 + nr)
                  .map((row) =>
                    Array.from({ length: nc }, (_, i) =>
                      String(row[c - 1 + i] ?? ""),
                    ),
                  );
              },
              setNumberFormat: () => range,
              setValues: (rows) => {
                if (opts.failWrite) throw new Error("save failed");
                writes++;
                for (let i = 0; i < rows.length; i++) {
                  tables[name][r - 1 + i] ??= [];
                  rows[i].forEach((v, j) => {
                    tables[name][r - 1 + i][c - 1 + j] = v.startsWith("'")
                      ? v.slice(1)
                      : v;
                  });
                }
                return range;
              },
            };
            return range;
          },
        };
  ctx.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) =>
        ({
          OWNER_EMAIL: "owner@test.invalid",
          LEDGER_SHEET_ID: "test",
          LEDGER_INSTANCE: "test-ledger",
        })[k],
    }),
  };
  ctx.Session = {
    getActiveUser: () => ({
      getEmail: () =>
        opts.stranger ? "stranger@test.invalid" : "owner@test.invalid",
    }),
    getEffectiveUser: () => ({ getEmail: () => "owner@test.invalid" }),
  };
  ctx.SpreadsheetApp = {
    openById: (id) => {
      if (id !== "test") throw new Error("wrong id");
      return {
        getSheetByName: sheet,
        insertSheet: (name) => {
          tables[name] = [];
          return sheet(name);
        },
      };
    },
    flush: () => {
      if (opts.failFlush) throw new Error("flush failed");
    },
  };
  ctx.LockService = {
    getScriptLock: () => ({ tryLock: () => !opts.locked, releaseLock() {} }),
  };
  ctx.Utilities = {
    formatDate: () => "2026-08-30",
    DigestAlgorithm: { SHA_256: "sha256" },
    computeDigest: (type, s) => crypto.createHash(type).update(s).digest(),
    base64EncodeWebSafe: (s) => s.toString("base64url"),
  };
  return { ctx, tables, writes: () => writes, plain };
}
