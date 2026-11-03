/** Offline integration preview. Synthetic data, localhost only, no external requests. */
import http from "node:http";
import fs from "node:fs";
import { environment } from "./tests/environment.mjs";
const env = environment({ indexed: true, candidates: true, cache: new Map() });
// Synthetic delivery sizes exercise iPad review and pagination (PREVIEW_PAPERS=51).
env.tables.Appearances.push([
  "preview-s3", "10", "issue1", "感染症", "2026-08-20",
  "Second paper in the same delivery", "candidate", "", "test", "t2",
]);
for (let index = 2; index < Number(process.env.PREVIEW_PAPERS || 15); index++) {
  const id = String(100 + index);
  const paper = [...env.tables.Papers[1]];
  paper[0] = id; paper[1] = "架空の候補論文 " + (index + 1);
  env.tables.Papers.push(paper);
  env.tables.Appearances.push([
    "preview-" + id, id, "issue1", "感染症", "2026-08-20",
    "架空の候補論文 " + (index + 1) + "：日常診療での判断に関する研究の評価", "candidate", "", "test", "t2",
  ]);
}
env.reindex();
const page = fs
  .readFileSync(new URL("./gas/Index.html", import.meta.url), "utf8")
  .replace("<?= initialPmid ?>", "")
  .replace("<?= initialIssue ?>", "")
  .replace("<?= profiling ?>", process.env.PREVIEW_PROFILE === "1" ? "1" : "")
  .replace("<?= profileWrites ?>", "1");
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
        "listIssuePapers",
        "getPaperDetail",
        "saveReviews",
        "exportData",
        "listIssues",
        "saveIssueReview",
        "profileLedger",
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
