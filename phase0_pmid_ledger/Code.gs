/** PMID ledger Phase 0. TEST ONLY. No network/AI/Drive/Docs/trigger services. */
var Phase0 = (function () {
  'use strict';
  var statuses = {
    unreviewed: '未確認', reviewed_no_fulltext: '確認済み・原文不要',
    want_fulltext: '原文入手希望', fulltext_obtained: '原文入手済み・未読', read: '読了'
  };
  var tabs = {
    recent: '最近の未確認', want: '原文入手待ち', obtained: '原文入手済み・未読',
    old: '過去の未確認', done: '確認完了'
  };
  var paperHeaders = ['pmid', 'title', 'topics', 'reference_date', 'review_status',
    'review_version', 'status_updated_at', 'last_operation_id', 'note'];
  var snapshotHeaders = ['snapshot_id', 'pmid', 'issue_id', 'topic_id', 'topic_label',
    'delivered_date', 'title_at_delivery', 'selection', 'summary_ja', 'one_line_assessment',
    'why_important', 'importance', 'source_kind', 'source_ref', 'current_doc_url'];
  function assert(ok, message) { if (!ok) throw new Error(message); }
  function pmid(value) {
    assert(typeof value === 'string' && /^[1-9][0-9]{0,8}$/.test(value), 'PMIDの形式が不正です。');
    return value;
  }
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    var d = new Date(value + 'T00:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }
  function cutoff(today) {
    assert(validDate(today), '基準日が不正です。');
    var parts = today.split('-').map(Number);
    var first = new Date(Date.UTC(parts[0], parts[1] - 4, 1));
    var lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    first.setUTCDate(Math.min(parts[2], lastDay));
    return first.toISOString().slice(0, 10);
  }
  function category(paper, boundary, today) {
    if (paper.review_status === 'want_fulltext') return 'want';
    if (paper.review_status === 'fulltext_obtained') return 'obtained';
    if (paper.review_status !== 'unreviewed') return 'done';
    // Unknown dates remain discoverable, but are never falsely labelled recent.
    return validDate(paper.reference_date) && paper.reference_date >= boundary &&
      paper.reference_date <= today ? 'recent' : 'old';
  }
  function list(papers, request, today) {
    request = request || {};
    var tab = request.tab || 'recent';
    assert(Object.prototype.hasOwnProperty.call(tabs, tab), '表示区分が不正です。');
    var offset = request.offset === undefined ? 0 : request.offset;
    assert(Number.isInteger(offset) && offset >= 0, 'ページ指定が不正です。');
    var boundary = cutoff(today), counts = { recent: 0, want: 0, obtained: 0, old: 0, done: 0 };
    papers.forEach(function (p) { counts[category(p, boundary, today)]++; });
    var rows = papers.filter(function (p) { return category(p, boundary, today) === tab; });
    rows.sort(function (a, b) {
      return (b.reference_date || '').localeCompare(a.reference_date || '') || Number(a.pmid) - Number(b.pmid);
    });
    return { tab: tab, tabs: tabs, statuses: statuses, counts: counts, total: rows.length,
      items: rows.slice(offset, offset + 50), offset: offset, page_size: 50, boundary: boundary, today: today };
  }
  function transition(paper, request, now) {
    pmid(request.pmid);
    assert(paper.pmid === request.pmid, '対象論文が一致しません。');
    assert(Object.prototype.hasOwnProperty.call(statuses, request.status), '確認状態が不正です。');
    assert(typeof request.operation_id === 'string' && /^[A-Za-z0-9-]{16,80}$/.test(request.operation_id),
      '操作IDが不正です。');
    assert(Number.isInteger(request.expected_version) && request.expected_version >= 0, '版数が不正です。');
    if (paper.last_operation_id === request.operation_id) {
      assert(paper.review_status === request.status, '操作IDの再利用を検出しました。');
      return paper;
    }
    assert(paper.review_version === request.expected_version,
      '別の画面で更新されています。再読み込みして、現在の状態を確認してください。');
    assert(request.simulate_failure !== true, 'TEST：保存前の失敗を発生させました。変更は保存していません。');
    var result = Object.assign({}, paper);
    result.review_status = request.status;
    result.review_version++;
    if (paper.review_status !== request.status) result.status_updated_at = now;
    result.last_operation_id = request.operation_id;
    return result;
  }
  function exportText(papers) {
    var ids = Array.from(new Set(papers.filter(function (p) {
      return p.review_status === 'want_fulltext';
    }).map(function (p) { return pmid(p.pmid); }))).sort(function (a, b) { return Number(a) - Number(b); });
    return { filename: 'pmids.txt', text: ids.length ? ids.join('\n') + '\n' : '', count: ids.length };
  }
  function records(values, headers) {
    assert(values.length > 0 && JSON.stringify(values[0]) === JSON.stringify(headers),
      'TESTシートの列構成が一致しません。処理を停止しました。');
    return values.slice(1).filter(function (row) { return row[0] !== ''; }).map(function (row) {
      var result = {};
      headers.forEach(function (key, i) { result[key] = row[i] === undefined ? '' : row[i]; });
      return result;
    });
  }
  return { statuses: statuses, tabs: tabs, paperHeaders: paperHeaders, snapshotHeaders: snapshotHeaders,
    assert: assert, pmid: pmid, cutoff: cutoff, category: category, list: list,
    transition: transition, exportText: exportText, records: records };
}());

// Replaced once with the newly-created TEST spreadsheet ID, never a production ID.
var PHASE0_SPREADSHEET_ID = '14ljGP2GidDOvmjDfrKBKdrIP5D_gM5K-4-VBP-4KLjc';
var PHASE0_INSTANCE = 'pmid-phase0-20260830-7d865256';
var PHASE0_TITLE = 'PMID確認台帳_TEST_Phase0_20260830';

function authorizePhase0_() {
  var owner = PropertiesService.getScriptProperties().getProperty('PHASE0_OWNER_EMAIL');
  var active = Session.getActiveUser().getEmail();
  var effective = Session.getEffectiveUser().getEmail();
  Phase0.assert(owner && active && active.toLowerCase() === owner.toLowerCase() &&
    effective.toLowerCase() === owner.toLowerCase(), '本人認証を確認できません。許可されたGoogleアカウントで開いてください。');
}

function testBook_() {
  authorizePhase0_();
  Phase0.assert(PHASE0_SPREADSHEET_ID !== 'TEST_SPREADSHEET_ID_PENDING', 'TEST台帳IDが未設定です。');
  var book = SpreadsheetApp.openById(PHASE0_SPREADSHEET_ID);
  Phase0.assert(book.getName() === PHASE0_TITLE, 'TEST台帳名が一致しません。処理を停止しました。');
  var settings = book.getSheetByName('_Settings');
  Phase0.assert(settings, 'TEST識別シートがありません。');
  var marker = settings.getRange('A1:B3').getDisplayValues();
  Phase0.assert(JSON.stringify(marker) === JSON.stringify([
    ['key', 'value'], ['environment', 'PHASE0_TEST'], ['instance_id', PHASE0_INSTANCE]
  ]), 'TEST識別情報が一致しません。処理を停止しました。');
  return book;
}

function readPapers_(book) {
  var sheet = book.getSheetByName('Papers');
  Phase0.assert(sheet && sheet.getLastRow() <= 101, 'Phase 0は100件以下のTESTデータ専用です。');
  var rows = Phase0.records(sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1),
    Phase0.paperHeaders.length).getValues(), Phase0.paperHeaders);
  var seen = {};
  rows.forEach(function (p) {
    p.pmid = Phase0.pmid(String(p.pmid));
    p.reference_date = p.reference_date instanceof Date ?
      Utilities.formatDate(p.reference_date, 'Asia/Tokyo', 'yyyy-MM-dd') : String(p.reference_date || '');
    p.status_updated_at = p.status_updated_at instanceof Date ? p.status_updated_at.toISOString() : String(p.status_updated_at || '');
    p.review_version = Number(p.review_version);
    Phase0.assert(!seen[p.pmid] && Object.prototype.hasOwnProperty.call(Phase0.statuses, p.review_status) &&
      Number.isInteger(p.review_version) && p.review_version >= 0, 'TEST論文データに重複または不正な状態があります。');
    seen[p.pmid] = true;
  });
  return rows;
}

function withPhase0Lock_(fn) {
  var lock = LockService.getScriptLock();
  Phase0.assert(lock.tryLock(5000), '別の操作を保存中です。少し待って再試行してください。');
  try { return fn(); } finally { lock.releaseLock(); }
}

function doGet() {
  authorizePhase0_();
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('PMID確認台帳 TEST')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function listPapers(request) {
  var book = testBook_();
  return Phase0.list(readPapers_(book), request, Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'));
}

function getPaperDetail(pmid) {
  Phase0.pmid(pmid);
  var book = testBook_(), papers = readPapers_(book);
  var paper = papers.find(function (p) { return p.pmid === pmid; });
  Phase0.assert(paper, '論文が見つかりません。');
  var sheet = book.getSheetByName('Appearances');
  Phase0.assert(sheet && sheet.getLastRow() <= 301, 'TEST掲載履歴が不正です。');
  var rows = Phase0.records(sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()),
    Phase0.snapshotHeaders.length).getDisplayValues(), Phase0.snapshotHeaders);
  var history = rows.filter(function (p) { return p.pmid === pmid; });
  history.sort(function (a, b) { return b.delivered_date.localeCompare(a.delivered_date); });
  return { paper: paper, appearances: history };
}

function changeStatus(request) {
  authorizePhase0_();
  Phase0.assert(request && typeof request === 'object', '更新要求が不正です。');
  return withPhase0Lock_(function () {
    var book = testBook_(), sheet = book.getSheetByName('Papers'), papers = readPapers_(book);
    var paper = papers.find(function (p) { return p.pmid === request.pmid; });
    Phase0.assert(paper, '論文が見つかりません。');
    var updated = Phase0.transition(paper, request, new Date().toISOString());
    // Find the physical row by PMID, not by a filtered array index or client row number.
    var ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues();
    var row = ids.findIndex(function (r) { return r[0] === request.pmid; }) + 2;
    Phase0.assert(row >= 2, '保存先の行が見つかりません。');
    if (updated !== paper) {
      // A single contiguous write; never touch titles, notes, or snapshots.
      sheet.getRange(row, 5, 1, 4).setValues([[
        updated.review_status, updated.review_version, updated.status_updated_at, updated.last_operation_id
      ]]);
      SpreadsheetApp.flush();
    }
    var saved = readPapers_(book).find(function (p) { return p.pmid === request.pmid; });
    Phase0.assert(saved.review_status === request.status && saved.last_operation_id === request.operation_id &&
      saved.review_version === updated.review_version, '保存の確認ができません。再読み込みして状態を確認してください。');
    return { saved: true, paper: saved };
  });
}

function exportWanted() {
  authorizePhase0_();
  return withPhase0Lock_(function () { return Phase0.exportText(readPapers_(testBook_())); });
}

function verifyPhase0Setup() {
  var book = testBook_();
  return { environment: 'PHASE0_TEST', title: book.getName(), paper_count: readPapers_(book).length,
    ai_api_calls: 0, note: '本人限定デプロイとiPad実機の検証は別途必要です。' };
}
