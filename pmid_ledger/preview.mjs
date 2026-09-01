/** Offline integration preview. Synthetic data, localhost only, no external requests. */
import http from "node:http";
import fs from "node:fs";
import { environment } from "./tests/environment.mjs";
const env = environment({ indexed: true, cache: new Map() });
// A second paper in one delivery demonstrates per-paper edits followed by one save.
env.tables.Appearances.push([
  "preview-s3", "10", "issue1", "感染症", "2026-08-20",
  "Second paper in the same delivery", "candidate", "", "test", "t2",
]);
env.reindex();
const page = fs
  .readFileSync(new URL("./gas/Index.html", import.meta.url), "utf8")
  .replace("<?= initialPmid ?>", "")
  .replace("<?= initialIssue ?>", "");
const bridge = `<script>window.google={script:{run:new Proxy({}, {get(target,name){if(name==='withSuccessHandler')return fn=>{target.success=fn;return new Proxy(target,this);};if(name==='withFailureHandler')return fn=>{target.failure=fn;return new Proxy(target,this);};return arg=>{const ok=target.success,fail=target.failure;fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,arg})}).then(r=>r.json()).then(r=>r.error?fail({message:r.error}):ok(r.value)).catch(fail);};}})}};</script>`;
const server = http.createServer(async (req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page.replace("<script>", bridge + "<script>"));
    return;
  }
  if (req.method !== "POST" || req.url !== "/rpc") {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1000000) throw new Error("Too large");
    }
    const { name, arg } = JSON.parse(body);
    if (
      ![
        "listPapers",
        "getPaperDetail",
        "saveReviews",
        "exportData",
        "listIssues",
        "saveIssueReview",
      ].includes(name)
    )
      throw new Error("Unknown method");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ value: env.ctx[name](arg) }));
  } catch (e) {
    res.end(JSON.stringify({ error: e.message }));
  }
});
server.listen(Number(process.env.PORT || 8766), "127.0.0.1", () =>
  console.log(`Synthetic-only preview: http://127.0.0.1:${process.env.PORT || 8766}`),
);
