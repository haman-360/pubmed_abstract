/** Production ledger. Metadata is Python-owned; only this app appends review events. */
var Ledger = (function () {
  "use strict";
  var statuses = {
    unreviewed: "未確認",
    reviewed_no_fulltext: "確認済み・原文不要",
    want_fulltext: "原文入手希望",
    fulltext_obtained: "原文入手済み・未読",
    read: "読了",
  };
  var tabs = {
    recent: "最近の未確認",
    want: "原文入手待ち",
    obtained: "原文入手済み・未読",
    old: "過去の未確認",
    done: "確認完了",
    active: "未確認・対応中",
    all: "すべて",
    archive: "3か月より古い論文",
  };
  var headers = {
    Papers: [
      "pmid",
      "title",
      "journal",
      "publication_date",
      "pubmed_url",
      "doi",
      "topics",
      "first_seen",
      "last_seen",
      "sources",
    ],
    Appearances: [
      "snapshot_id",
      "pmid",
      "issue_id",
      "topic",
      "delivered_date",
      "title_at_delivery",
      "selection",
      "current_doc_url",
      "source",
      "text_id",
    ],
    Texts: ["text_id", "part", "body"],
    Reviews: [
      "operation_id",
      "pmid",
      "version",
      "status",
      "status_updated_at",
      "note",
      "updated_at",
      "request_hash",
    ],
    Settings: ["key", "value"],
    IssueReviews: [
      "operation_id",
      "issue_key",
      "version",
      "status",
      "content_version",
      "updated_at",
      "request_hash",
    ],
  };
  function assert(ok, msg) {
    if (!ok) throw new Error(msg);
  }
  function pmid(s) {
    assert(
      typeof s === "string" && /^[1-9][0-9]{0,8}$/.test(s),
      "PMIDの形式が不正です。",
    );
    return s;
  }
  function records(rows, name) {
    assert(
      JSON.stringify(rows[0]) === JSON.stringify(headers[name]),
      "列構成が不正です：" + name,
    );
    return rows
      .slice(1)
      .filter(function (r) {
        return r[0] !== "";
      })
      .map(function (r) {
        var o = {};
        headers[name].forEach(function (h, i) {
          o[h] = r[i] === undefined ? "" : r[i];
        });
        return o;
      });
  }
  function cutoff(today) {
    var p = today.split("-").map(Number),
      d = new Date(Date.UTC(p[0], p[1] - 4, 1));
    d.setUTCDate(
      Math.min(
        p[2],
        new Date(
          Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
        ).getUTCDate(),
      ),
    );
    return d.toISOString().slice(0, 10);
  }
  function reviews(events) {
    var result = {};
    events.forEach(function (e) {
      pmid(e.pmid);
      assert(
        Object.prototype.hasOwnProperty.call(statuses, e.status),
        "不正な状態",
      );
      var v = Number(e.version);
      assert(Number.isInteger(v) && v > 0, "不正な版数");
      assert(
        !result[e.pmid] || v > result[e.pmid].version,
        "状態履歴の版数が重複しています",
      );
      result[e.pmid] = Object.assign({}, e, { version: v });
    });
    return result;
  }
  function enrich(papers, appearances, events) {
    var states = reviews(events),
      seen = {},
      byId = {};
    appearances.forEach(function (a) {
      (byId[a.pmid] || (byId[a.pmid] = [])).push(a);
    });
    return papers.map(function (raw) {
      var p = Object.assign({}, raw);
      pmid(p.pmid);
      assert(!seen[p.pmid], "PMIDが重複しています");
      seen[p.pmid] = true;
      p.topics = JSON.parse(p.topics);
      p.sources = JSON.parse(p.sources);
      p.appearances = byId[p.pmid] || [];
      var dates = p.appearances
        .map(function (a) {
          return a.delivered_date;
        })
        .filter(Boolean)
        .sort();
      p.delivery_date = dates.length ? dates[dates.length - 1] : "";
      p.reference_date = p.delivery_date || p.last_seen || "";
      p.date_kind = p.delivery_date
        ? "配信"
        : p.last_seen
          ? "検出"
          : "日付不明";
      p.review = states[p.pmid] || {
        status: "unreviewed",
        version: 0,
        note: "",
        status_updated_at: "",
        updated_at: "",
      };
      return p;
    });
  }
  function category(p, boundary, today) {
    var s = p.review.status;
    if (s === "want_fulltext") return "want";
    if (s === "fulltext_obtained") return "obtained";
    if (s !== "unreviewed") return "done";
    return p.reference_date >= boundary && p.reference_date <= today
      ? "recent"
      : "old";
  }
  function query(papers, r, today) {
    r = r || {};
    var boundary = cutoff(today),
      tab = r.tab || "recent";
    assert(
      Object.prototype.hasOwnProperty.call(tabs, tab),
      "表示区分が不正です",
    );
    var counts = { recent: 0, want: 0, obtained: 0, old: 0, done: 0 };
    papers.forEach(function (p) {
      counts[category(p, boundary, today)]++;
    });
    var term = String(r.query || "")
      .trim()
      .toLocaleLowerCase();
    assert(term.length <= 300, "検索語が長すぎます");
    ["from", "to"].forEach(function (k) {
      assert(!r[k] || /^\d{4}-\d{2}-\d{2}$/.test(r[k]), "日付の形式が不正です");
    });
    assert(!r.from || !r.to || r.from <= r.to, "日付の範囲が逆です");
    var rows = papers.filter(function (p) {
      if (
        r.issue_key &&
        !p.appearances.some(function (a) {
          return issueKey_(a) === r.issue_key;
        })
      )
        return false;
      var c = category(p, boundary, today);
      if (
        tab === "active" &&
        !["recent", "old", "want", "obtained"].includes(c)
      )
        return false;
      if (
        tab === "archive" &&
        (!p.reference_date || p.reference_date >= boundary)
      )
        return false;
      if (!["all", "active", "archive"].includes(tab) && c !== tab)
        return false;
      if (
        term &&
        !p.pmid.includes(term) &&
        !p.title.toLocaleLowerCase().includes(term)
      )
        return false;
      if (r.status && p.review.status !== r.status) return false;
      // Date+topic must match the SAME appearance, not two unrelated issues.
      if (r.from || r.to) {
        if (
          !p.appearances.some(function (a) {
            return (
              a.delivered_date &&
              (!r.topic || a.topic === r.topic) &&
              (!r.from || a.delivered_date >= r.from) &&
              (!r.to || a.delivered_date <= r.to)
            );
          })
        )
          return false;
      } else if (
        r.topic &&
        !p.topics.includes(r.topic) &&
        !p.appearances.some(function (a) {
          return a.topic === r.topic;
        })
      )
        return false;
      return true;
    });
    var sort = r.sort || "delivery_desc";
    assert(
      [
        "delivery_desc",
        "delivery_asc",
        "pmid_asc",
        "pmid_desc",
        "updated_desc",
      ].includes(sort),
      "並べ替えが不正です",
    );
    rows.sort(function (a, b) {
      if (sort.indexOf("pmid_") === 0)
        return (
          (sort === "pmid_asc" ? 1 : -1) * (Number(a.pmid) - Number(b.pmid))
        );
      var av =
          sort === "updated_desc"
            ? a.review.status_updated_at
            : a.delivery_date,
        bv =
          sort === "updated_desc"
            ? b.review.status_updated_at
            : b.delivery_date;
      if (!av !== !bv) return av ? -1 : 1;
      return (
        (sort === "delivery_asc" ? 1 : -1) * av.localeCompare(bv) ||
        Number(a.pmid) - Number(b.pmid)
      );
    });
    var topics = Array.from(
      new Set(
        papers.reduce(function (a, p) {
          return a.concat(
            p.topics,
            p.appearances.map(function (h) {
              return h.topic;
            }),
          );
        }, []),
      ),
    )
      .filter(Boolean)
      .sort();
    return {
      rows: rows,
      counts: counts,
      boundary: boundary,
      today: today,
      topics: topics,
    };
  }
  function csv(rows) {
    return (
      rows
        .map(function (row) {
          return row
            .map(function (v) {
              v = String(v === undefined ? "" : v);
              if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
              return '"' + v.replace(/"/g, '""') + '"';
            })
            .join(",");
        })
        .join("\r\n") + "\r\n"
    );
  }
  function txt(papers, ids) {
    var chosen = ids ? new Set(ids.map(pmid)) : null;
    var result = Array.from(
      new Set(
        papers
          .filter(function (p) {
            return (
              p.review.status === "want_fulltext" &&
              (!chosen || chosen.has(p.pmid))
            );
          })
          .map(function (p) {
            return p.pmid;
          }),
      ),
    ).sort(function (a, b) {
      return Number(a) - Number(b);
    });
    return {
      filename: "pmids.txt",
      text: result.length ? result.join("\n") + "\n" : "",
      count: result.length,
    };
  }
  return {
    statuses: statuses,
    tabs: tabs,
    headers: headers,
    assert: assert,
    pmid: pmid,
    records: records,
    cutoff: cutoff,
    reviews: reviews,
    enrich: enrich,
    query: query,
    csv: csv,
    txt: txt,
  };
})();

function authorize_() {
  var p = PropertiesService.getScriptProperties(),
    owner = p.getProperty("OWNER_EMAIL");
  Ledger.assert(
    owner &&
      Session.getActiveUser().getEmail().toLowerCase() ===
        owner.toLowerCase() &&
      Session.getEffectiveUser().getEmail().toLowerCase() ===
        owner.toLowerCase(),
    "本人認証を確認できません。ご本人のGoogleアカウントで開いてください。",
  );
  return p;
}
function book_() {
  var props = authorize_(),
    id = props.getProperty("LEDGER_SHEET_ID"),
    instance = props.getProperty("LEDGER_INSTANCE");
  Ledger.assert(id && instance, "本番台帳の設定が必要です");
  var book = SpreadsheetApp.openById(id),
    settings = read_(book, "Settings"),
    map = {};
  settings.forEach(function (r) {
    map[r.key] = r.value;
  });
  Ledger.assert(
    map.schema === "PMID_LEDGER_V1" && map.instance === instance,
    "台帳の環境識別子が一致しません",
  );
  return { book: book, settings: map };
}
function read_(book, name) {
  var sheet = book.getSheetByName(name);
  if (name === "IssueReviews" && (!sheet || sheet.getLastRow() === 0))
    return [];
  Ledger.assert(sheet, "必要なシートがありません：" + name);
  return Ledger.records(
    sheet
      .getRange(
        1,
        1,
        Math.max(1, sheet.getLastRow()),
        Ledger.headers[name].length,
      )
      .getDisplayValues(),
    name,
  );
}
function state_() {
  var ctx = book_();
  ctx.papers = Ledger.enrich(
    read_(ctx.book, "Papers"),
    read_(ctx.book, "Appearances"),
    read_(ctx.book, "Reviews"),
  );
  var latest = {};
  read_(ctx.book, "Settings").forEach(function (r) {
    latest[r.key] = r.value;
  });
  Ledger.assert(
    latest.revision === ctx.settings.revision,
    "台帳の同期中です。再読み込みしてください。",
  );
  return ctx;
}
function today_() {
  return Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
}
function locked_(fn) {
  authorize_();
  var lock = LockService.getScriptLock();
  Ledger.assert(
    lock.tryLock(10000),
    "別の操作を保存中です。少し待って再試行してください。",
  );
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
function doGet(e) {
  authorize_();
  var template = HtmlService.createTemplateFromFile("Index");
  template.initialPmid =
    e && e.parameter && /^[1-9][0-9]{0,8}$/.test(e.parameter.pmid || "")
      ? e.parameter.pmid
      : "";
  template.initialIssue =
    e && e.parameter && e.parameter.issue
      ? validateIssueKey_(e.parameter.issue)
      : "";
  return template
    .evaluate()
    .setTitle("PMID論文確認台帳")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}
function listPapers(request) {
  var ctx = state_(),
    scoped = ctx.papers,
    issue = null;
  if (request && request.issue_key) {
    validateIssueKey_(request.issue_key);
    issue = issueState_(ctx).find(function (i) {
      return i.issue_key === request.issue_key;
    });
    Ledger.assert(issue, "配信が見つかりません");
    scoped = ctx.papers
      .filter(function (p) {
        return p.appearances.some(function (a) {
          return issueKey_(a) === request.issue_key;
        });
      })
      .map(function (p) {
        var copy = Object.assign({}, p);
        copy.appearances = p.appearances.filter(function (a) {
          return issueKey_(a) === request.issue_key;
        });
        copy.topics = [issue.topic];
        copy.title = copy.appearances[0].title_at_delivery || p.title;
        copy.delivery_date = issue.delivered_date;
        copy.reference_date = issue.delivered_date;
        copy.date_kind = issue.delivered_date ? "配信" : "日付不明";
        return copy;
      });
  }
  var q = Ledger.query(scoped, request, today_()),
    offset = (request && request.offset) || 0;
  Ledger.assert(
    Number.isInteger(offset) && offset >= 0,
    "ページ指定が不正です",
  );
  if (offset >= q.rows.length)
    offset = Math.max(0, Math.floor((q.rows.length - 1) / 50) * 50);
  var items = q.rows.slice(offset, offset + 50).map(function (p) {
    var item = Object.assign({}, p);
    item.appearance_count = p.appearances.length;
    item.doc_links = Array.from(
      new Set(
        p.appearances
          .map(function (a) {
            return a.current_doc_url;
          })
          .filter(Boolean),
      ),
    );
    delete item.appearances;
    return item;
  });
  return {
    items: items,
    total: q.rows.length,
    offset: offset,
    page_size: 50,
    counts: q.counts,
    topics: q.topics,
    boundary: q.boundary,
    today: q.today,
    statuses: Ledger.statuses,
    tabs: Ledger.tabs,
    synced_at: ctx.settings.synced_at,
    revision: ctx.settings.revision,
    environment: ctx.settings.instance,
    issue: issue,
  };
}
function getPaperDetail(request) {
  var pmid = typeof request === "string" ? request : request.pmid;
  var issueKey = typeof request === "string" ? "" : request.issue_key;
  Ledger.pmid(pmid);
  var ctx = state_(),
    p = ctx.papers.find(function (x) {
      return x.pmid === pmid;
    });
  Ledger.assert(p, "論文が見つかりません");
  if (issueKey)
    p.appearances = p.appearances.filter(function (a) {
      return issueKey_(a) === issueKey;
    });
  var ids = new Set(
      p.appearances.map(function (a) {
        return a.text_id;
      }),
    ),
    chunks = {};
  read_(ctx.book, "Texts").forEach(function (t) {
    if (ids.has(t.text_id))
      (chunks[t.text_id] || (chunks[t.text_id] = [])).push(t);
  });
  var appearances = p.appearances.map(function (a) {
    var parts = (chunks[a.text_id] || []).sort(function (x, y) {
      return Number(x.part) - Number(y.part);
    });
    Ledger.assert(
      parts.length &&
        parts.every(function (t, i) {
          return Number(t.part) === i;
        }),
      "要約本文の保存データが不完全です",
    );
    return Object.assign({}, a, {
      text: JSON.parse(
        parts
          .map(function (t) {
            return t.body;
          })
          .join(""),
      ),
    });
  });
  appearances.sort(function (a, b) {
    return (
      b.delivered_date.localeCompare(a.delivered_date) ||
      a.issue_id.localeCompare(b.issue_id)
    );
  });
  return { paper: p, appearances: appearances };
}
function saveReviews(request) {
  return locked_(function () {
    Ledger.assert(
      request &&
        Array.isArray(request.changes) &&
        request.changes.length > 0 &&
        request.changes.length <= 100,
      "一度に保存できるのは1〜100件です",
    );
    Ledger.assert(
      /^[A-Za-z0-9-]{16,80}$/.test(request.operation_id || ""),
      "操作IDが不正です",
    );
    var ctx = state_(),
      events = read_(ctx.book, "Reviews"),
      changes = request.changes,
      ids = new Set();
    changes.forEach(function (c) {
      Ledger.pmid(c.pmid);
      Ledger.assert(!ids.has(c.pmid), "更新対象が重複しています");
      ids.add(c.pmid);
      Ledger.assert(
        Object.prototype.hasOwnProperty.call(Ledger.statuses, c.status) &&
          typeof c.note === "string" &&
          c.note.length <= 2000 &&
          Number.isInteger(c.expected_version),
        "更新内容が不正です（メモは2000文字以内）",
      );
    });
    var hash = Utilities.base64EncodeWebSafe(
        Utilities.computeDigest(
          Utilities.DigestAlgorithm.SHA_256,
          JSON.stringify(changes),
        ),
      ),
      prior = events.filter(function (e) {
        return e.operation_id === request.operation_id;
      });
    if (prior.length) {
      Ledger.assert(
        prior.length === changes.length &&
          prior.every(function (e) {
            return e.request_hash === hash;
          }),
        "操作IDが別の内容に再利用されています",
      );
      return { saved: true, replayed: true, count: prior.length };
    }
    var now = new Date().toISOString(),
      rows = changes.map(function (c) {
        var paper = ctx.papers.find(function (p) {
          return p.pmid === c.pmid;
        });
        Ledger.assert(paper, "論文が見つかりません");
        Ledger.assert(
          paper.review.version === c.expected_version,
          "別の画面で更新されています。再読み込みしてください：PMID " + c.pmid,
        );
        return [
          request.operation_id,
          c.pmid,
          String(c.expected_version + 1),
          c.status,
          c.status === paper.review.status
            ? paper.review.status_updated_at
            : now,
          c.note,
          now,
          hash,
        ];
      });
    Ledger.assert(
      !request.simulate_failure,
      "TEST：保存前の失敗を発生させました",
    );
    var sheet = ctx.book.getSheetByName("Reviews"),
      start = sheet.getLastRow() + 1;
    if (start + rows.length - 1 > sheet.getMaxRows())
      sheet.insertRowsAfter(sheet.getMaxRows(), Math.max(1000, rows.length));
    // Prefix formula-like inputs for SpreadsheetApp; displayed values retain the user's exact text.
    sheet
      .getRange(start, 1, rows.length, 8)
      .setNumberFormat("@")
      .setValues(
        rows.map(function (r) {
          return r.map(function (v) {
            return /^[=']/.test(v) ? "'" + v : v;
          });
        }),
      );
    SpreadsheetApp.flush();
    var saved = sheet.getRange(start, 1, rows.length, 8).getDisplayValues();
    Ledger.assert(
      JSON.stringify(saved) === JSON.stringify(rows),
      "保存結果を確認できません。再読み込みして状態をご確認ください。",
    );
    return { saved: true, count: rows.length };
  });
}
function exportData(request) {
  request = request || {};
  var ctx = state_();
  if (request.format === "txt")
    return Ledger.txt(ctx.papers, request.ids || null);
  if (request.format === "csv") {
    var q = Ledger.query(
        ctx.papers,
        request.filter || { tab: "all" },
        today_(),
      ),
      rows = [
        [
          "PMID",
          "タイトル",
          "雑誌",
          "発表日",
          "分野",
          "配信日",
          "初回検出日",
          "最終検出日",
          "状態",
          "状態更新日時",
          "メモ",
          "PubMed",
          "現在版Googleドキュメント",
        ],
      ];
    q.rows.forEach(function (p) {
      rows.push([
        p.pmid,
        p.title,
        p.journal,
        p.publication_date,
        p.topics.join(" / "),
        p.delivery_date,
        p.first_seen,
        p.last_seen,
        p.review.status,
        p.review.status_updated_at,
        p.review.note,
        p.pubmed_url,
        Array.from(
          new Set(
            p.appearances
              .map(function (a) {
                return a.current_doc_url;
              })
              .filter(Boolean),
          ),
        ).join(" "),
      ]);
    });
    return {
      filename: "pmid-ledger.csv",
      text: Ledger.csv(rows),
      count: q.rows.length,
    };
  }
  if (request.format === "backup") {
    return locked_(function () {
      var b = book_(),
        tables = {};
      Object.keys(Ledger.headers).forEach(function (name) {
        var sheet = b.book.getSheetByName(name);
        if (name === "IssueReviews" && (!sheet || sheet.getLastRow() === 0)) {
          tables[name] = [Ledger.headers[name]];
          return;
        }
        tables[name] = sheet
          .getRange(
            1,
            1,
            Math.max(1, sheet.getLastRow()),
            Ledger.headers[name].length,
          )
          .getDisplayValues();
      });
      var finalSettings = {};
      read_(b.book, "Settings").forEach(function (r) {
        finalSettings[r.key] = r.value;
      });
      Ledger.assert(
        finalSettings.revision === b.settings.revision,
        "台帳の同期中です。バックアップを再実行してください。",
      );
      return {
        filename: "pmid-ledger-backup-" + today_() + ".json",
        text: JSON.stringify({
          schema: "PMID_LEDGER_V1",
          instance: b.settings.instance,
          tables: tables,
        }),
        count: tables.Papers.length - 1,
      };
    });
  }
  throw new Error("出力形式が不正です");
}

// A delivery is (issue_id, topic), never the mutable CURRENT document ID.
function issueKey_(a) {
  return JSON.stringify([a.issue_id, a.topic]);
}
function validateIssueKey_(key) {
  Ledger.assert(
    typeof key === "string" && key.length <= 1200,
    "配信キーが不正です",
  );
  var pair = JSON.parse(key);
  Ledger.assert(
    Array.isArray(pair) &&
      pair.length === 2 &&
      pair[0] &&
      pair.every(function (v) {
        return typeof v === "string" && v.length <= 500;
      }) &&
      JSON.stringify(pair) === key,
    "配信キーが不正です",
  );
  return key;
}
function hashIssue_(value) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      JSON.stringify(value),
    ),
  );
}
function issueState_(ctx) {
  var groups = {},
    states = {};
  read_(ctx.book, "IssueReviews").forEach(function (e) {
    validateIssueKey_(e.issue_key);
    Ledger.assert(
      ["unreviewed", "in_progress", "completed"].includes(e.status),
      "配信の状態が不正です",
    );
    Ledger.assert(
      Number(e.version) ===
        (states[e.issue_key] ? Number(states[e.issue_key].version) : 0) + 1,
      "配信の操作履歴が不完全です",
    );
    states[e.issue_key] = e;
  });
  ctx.papers.forEach(function (p) {
    p.appearances.forEach(function (a) {
      var key = issueKey_(a),
        g = groups[key];
      if (!g)
        g = groups[key] = {
          issue_key: key,
          issue_id: a.issue_id,
          topic: a.topic,
          dates: [],
          doc_links: [],
          snapshots: [],
          papers: {},
        };
      if (a.delivered_date) g.dates.push(a.delivered_date);
      if (a.current_doc_url) g.doc_links.push(a.current_doc_url);
      g.snapshots.push(a.snapshot_id);
      g.papers[p.pmid] = p.review.status;
    });
  });
  return Object.keys(groups).map(function (key) {
    var g = groups[key],
      review = states[key],
      ids = Object.keys(g.papers);
    var content = hashIssue_(Array.from(new Set(g.snapshots)).sort());
    var changed =
      !!review &&
      review.status === "completed" &&
      review.content_version !== content;
    return {
      issue_key: key,
      issue_id: g.issue_id,
      topic: g.topic,
      delivered_date: g.dates.sort().slice(-1)[0] || "",
      doc_links: Array.from(new Set(g.doc_links)),
      total: ids.length,
      unreviewed: ids.filter(function (id) {
        return g.papers[id] === "unreviewed";
      }).length,
      status: changed ? "in_progress" : review ? review.status : "unreviewed",
      content_changed: changed,
      version: review ? Number(review.version) : 0,
      content_version: content,
      updated_at: review ? review.updated_at : "",
      recovered: /^(local:|current_copy:)/.test(g.issue_id),
    };
  });
}
function listIssues(request) {
  request = request || {};
  var ctx = state_(),
    all = issueState_(ctx),
    counts = { unreviewed: 0, in_progress: 0, completed: 0 };
  all.forEach(function (i) {
    counts[i.status]++;
  });
  var filter = request.status || "open";
  Ledger.assert(
    ["all", "open", "unreviewed", "in_progress", "completed"].includes(filter),
    "配信の絞り込みが不正です",
  );
  ["from", "to"].forEach(function (k) {
    Ledger.assert(
      !request[k] || /^\d{4}-\d{2}-\d{2}$/.test(request[k]),
      "配信日の形式が不正です",
    );
  });
  Ledger.assert(
    !request.from || !request.to || request.from <= request.to,
    "日付の範囲が逆です",
  );
  var rows = all.filter(function (i) {
    return (
      (filter === "all" ||
        (filter === "open" ? i.status !== "completed" : i.status === filter)) &&
      (!request.topic || request.topic === i.topic) &&
      (!request.from ||
        (i.delivered_date && i.delivered_date >= request.from)) &&
      (!request.to || (i.delivered_date && i.delivered_date <= request.to))
    );
  });
  rows.sort(function (a, b) {
    return (
      b.delivered_date.localeCompare(a.delivered_date) ||
      b.issue_id.localeCompare(a.issue_id) ||
      a.topic.localeCompare(b.topic)
    );
  });
  var offset = request.offset || 0;
  Ledger.assert(
    Number.isInteger(offset) && offset >= 0,
    "ページ指定が不正です",
  );
  if (offset >= rows.length)
    offset = Math.max(0, Math.floor((rows.length - 1) / 50) * 50);
  return {
    environment: ctx.settings.instance,
    synced_at: ctx.settings.synced_at,
    items: rows.slice(offset, offset + 50),
    total: rows.length,
    offset: offset,
    counts: counts,
    topics: Array.from(
      new Set(
        all.map(function (i) {
          return i.topic;
        }),
      ),
    ).sort(),
  };
}
function saveIssueReview(request) {
  return locked_(function () {
    Ledger.assert(
      request && /^[A-Za-z0-9-]{16,80}$/.test(request.operation_id || ""),
      "操作IDが不正です",
    );
    validateIssueKey_(request.issue_key);
    Ledger.assert(
      ["unreviewed", "in_progress", "completed"].includes(request.status) &&
        Number.isInteger(request.expected_version) &&
        typeof request.content_version === "string",
      "配信の更新内容が不正です",
    );
    var ctx = state_(),
      events = read_(ctx.book, "IssueReviews");
    var hash = hashIssue_([
      request.issue_key,
      request.status,
      request.expected_version,
      request.content_version,
    ]);
    var prior = events.filter(function (e) {
      return e.operation_id === request.operation_id;
    });
    if (prior.length) {
      Ledger.assert(
        prior.length === 1 && prior[0].request_hash === hash,
        "操作IDが別の内容に再利用されています",
      );
      return { saved: true, replayed: true };
    }
    var issue = issueState_(ctx).find(function (i) {
      return i.issue_key === request.issue_key;
    });
    Ledger.assert(issue, "配信が見つかりません");
    Ledger.assert(
      issue.version === request.expected_version &&
        issue.content_version === request.content_version,
      "配信内容または確認状態が更新されています。再読み込みしてください。",
    );
    Ledger.assert(
      request.status !== "completed" || issue.unreviewed === 0,
      "未確認のPMIDが残っています。この配信の論文を振り分けてから確認済みにしてください。",
    );
    Ledger.assert(
      !request.simulate_failure,
      "TEST：保存前の失敗を発生させました",
    );
    var sheet = ctx.book.getSheetByName("IssueReviews");
    if (!sheet) {
      sheet = ctx.book.insertSheet("IssueReviews");
      sheet.getRange(1, 1, 1, 7).setValues([Ledger.headers.IssueReviews]);
      sheet.setFrozenRows(1);
    }
    // Recover only an empty sheet left by interrupted first-time setup.
    if (sheet.getLastRow() === 0)
      sheet.getRange(1, 1, 1, 7).setValues([Ledger.headers.IssueReviews]);
    var row = [
      request.operation_id,
      request.issue_key,
      String(issue.version + 1),
      request.status,
      issue.content_version,
      new Date().toISOString(),
      hash,
    ];
    var start = sheet.getLastRow() + 1;
    if (start > sheet.getMaxRows())
      sheet.insertRowsAfter(sheet.getMaxRows(), 1000);
    sheet.getRange(start, 1, 1, 7).setNumberFormat("@").setValues([row]);
    SpreadsheetApp.flush();
    Ledger.assert(
      JSON.stringify(sheet.getRange(start, 1, 1, 7).getDisplayValues()) ===
        JSON.stringify([row]),
      "保存結果を確認できません。再読み込みしてください。",
    );
    return { saved: true };
  });
}
