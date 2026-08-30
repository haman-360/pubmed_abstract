// One-time local workbook creation, never accesses Google or any AI API.
// NODE_PATH is not used by ESM: run with @oai/artifact-tool available in node_modules.
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';
import { papers, appearances, settings } from './fixtures.mjs';
const out = process.argv[2];
if (!out) throw new Error('Supply an output directory (not a live spreadsheet).');
await fs.mkdir(out, { recursive: true });
const ctx = vm.createContext({});
vm.runInContext(await fs.readFile(new URL('./Code.gs', import.meta.url), 'utf8'), ctx);
const wb = Workbook.create();
const specs = [
  ['Papers', [ctx.Phase0.paperHeaders, ...papers.map(p => ctx.Phase0.paperHeaders.map(h => p[h]))]],
  ['Appearances', [ctx.Phase0.snapshotHeaders, ...appearances.map(p => ctx.Phase0.snapshotHeaders.map(h => p[h]))]],
  ['_Settings', settings]
];
for (const [name, values] of specs) {
  const sheet = wb.worksheets.add(name); sheet.showGridLines = false;
  const range = sheet.getRangeByIndexes(0, 0, values.length, values[0].length);
  range.setNumberFormat('@'); range.values = values;
  range.format.font.name = 'Arial'; range.format.font.size = 11;
  range.format.columnWidthPx = 160; range.format.rowHeight = 64; range.format.wrapText = true;
  const head = sheet.getRangeByIndexes(0, 0, 1, values[0].length);
  head.format.fill = '#E8EEF0'; head.format.font.bold = true; head.format.rowHeight = 42;
  if (name === 'Papers') { sheet.getRange('B:B').format.columnWidthPx = 300; sheet.getRange('I:I').format.columnWidthPx = 300; }
  if (name === 'Appearances') sheet.getRange('G:O').format.columnWidthPx = 300;
  if (name === '_Settings') sheet.getRange('B:B').format.columnWidthPx = 340;
  sheet.freezePanes.freezeRows(1);
  const png = await wb.render({ sheetName: name, range: name === '_Settings' ? 'A1:B3' : name === 'Papers' ? 'A1:E5' : 'G1:J4', scale: 1, format: 'png' });
  await fs.writeFile(`${out}/${name}.png`, new Uint8Array(await png.arrayBuffer()));
}
console.log((await wb.inspect({kind:'sheet', include:'id,name', maxChars:2000})).ndjson);
await (await SpreadsheetFile.exportXlsx(wb)).save(`${out}/pmid_phase0_test.xlsx`);
