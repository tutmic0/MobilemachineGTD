#!/usr/bin/env node
/**
 * One-time migration: imports the existing Google Sheet's rows into the
 * new Postgres database, so nobody who already signed up loses their
 * spins/win/redeemed codes when you switch off Apps Script.
 *
 * How to get the CSV:
 *   Open the Google Sheet -> File -> Download -> Comma Separated Values (.csv)
 *   (download just the one tab that has your signups -- the one with the
 *   Handle / ActionSpins / CodeSpins / ... header row)
 *
 * How to run this:
 *   1. Make sure `npm install` has been run in this folder (installs `pg`).
 *   2. Set POSTGRES_URL to your Vercel Postgres connection string --
 *      either export it in your shell, or prefix the command with it:
 *
 *      POSTGRES_URL="postgres://...neon.tech/..." node scripts/migrate-sheet-to-postgres.js path/to/export.csv
 *
 * It's safe to run more than once -- rows are upserted by handle, and
 * campaign_state.winners_count is *set* (not incremented) to match
 * however many imported rows have HasWon = TRUE, at the end.
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

function parseCsv(text) {
  // Small dependency-free CSV parser -- handles quoted fields (with
  // embedded commas/newlines/escaped quotes), which is all a Google
  // Sheets CSV export needs.
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

function truthy(v) {
  return (v || "").toString().trim().toUpperCase() === "TRUE";
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("Usage: node scripts/migrate-sheet-to-postgres.js path/to/export.csv");
    process.exit(1);
  }
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("Missing POSTGRES_URL (or DATABASE_URL) environment variable.");
    process.exit(1);
  }

  const text = fs.readFileSync(path.resolve(csvPath), "utf8");
  const rows = parseCsv(text);
  if (!rows.length) {
    console.error("CSV is empty.");
    process.exit(1);
  }

  const header = rows[0].map((h) => h.trim());
  const expected = ["Handle", "ActionSpins", "CodeSpins", "SpinsUsed", "HasWon", "Address", "RedeemedCodes", "Timestamp"];
  const idx = {};
  expected.forEach((name) => {
    idx[name] = header.indexOf(name);
  });
  if (idx.Handle === -1) {
    console.error("Couldn't find a 'Handle' column in the CSV header:", header.join(", "));
    process.exit(1);
  }

  const dataRows = rows.slice(1).filter((r) => (r[idx.Handle] || "").trim().length > 0);
  console.log(`Found ${dataRows.length} signup rows to import.`);

  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let imported = 0;
    let winners = 0;
    for (const r of dataRows) {
      const handle = (r[idx.Handle] || "").trim();
      if (!handle) continue;
      const actionSpins = Number(r[idx.ActionSpins]) || 0;
      const codeSpins = Number(r[idx.CodeSpins]) || 0;
      const spinsUsed = Number(r[idx.SpinsUsed]) || 0;
      const hasWon = truthy(r[idx.HasWon]);
      const address = idx.Address !== -1 ? (r[idx.Address] || "").trim() : "";
      const redeemedCodes = idx.RedeemedCodes !== -1 ? (r[idx.RedeemedCodes] || "").trim() : "";

      await client.query(
        `insert into signups (handle, action_spins, code_spins, spins_used, has_won, address, redeemed_codes)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (handle) do update set
           action_spins = excluded.action_spins,
           code_spins = excluded.code_spins,
           spins_used = excluded.spins_used,
           has_won = excluded.has_won,
           address = excluded.address,
           redeemed_codes = excluded.redeemed_codes,
           updated_at = now()`,
        [handle, actionSpins, codeSpins, spinsUsed, hasWon, address, redeemedCodes]
      );
      imported++;
      if (hasWon) winners++;
    }

    await client.query("update campaign_state set winners_count = $1 where id = 1", [winners]);
    await client.query("COMMIT");
    console.log(`Imported ${imported} rows. Winners so far: ${winners}.`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed, nothing was written:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
