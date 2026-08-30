// Synthetic records only; these titles/assessments do not describe the linked real PMIDs.
export const title = 'PMID確認台帳_TEST_Phase0_20260830';
export const instance = 'pmid-phase0-20260830-7d865256';
export const currentDoc = 'https://docs.google.com/document/d/1vcjrXe7XRORJIIcKxKlhh4pRwqH-3qkOWCKTYetIk7A/edit';
const seeds = [
  ['1', '選定論文・複数の配信履歴', '小児感染症', '2026-08-29', 'unreviewed'],
  ['2', '候補表の一行評価', '小児腎臓病', '2026-08-28', 'unreviewed'],
  ['10', '古くても原文入手待ち', '小児喘息・アレルギー', '2026-04-01', 'want_fulltext'],
  ['20', '古くても原文入手済み・未読', '小児プライマリーケア', '2026-03-01', 'fulltext_obtained'],
  ['3', '過去の未確認', '総説・高インパクト', '2026-04-30', 'unreviewed'],
  ['4', '日付不明・要約未復元', '不明', '', 'unreviewed'],
  ['5', '確認済み・原文不要', '小児感染症', '2026-08-27', 'reviewed_no_fulltext'],
  ['6', '読了', '小児腎臓病', '2026-08-26', 'read']
];
export const papers = seeds.map(([pmid, label, topics, reference_date, review_status]) => ({
  pmid, title: `【TEST架空】${label}`, topics, reference_date, review_status,
  review_version: 0, status_updated_at: '', last_operation_id: '', note: 'TESTメモ：状態を変更してもこのメモは残ります。'
}));
export const appearances = papers.filter(p => p.pmid !== '4').map((p, i) => ({
  snapshot_id: `test-snapshot-${p.pmid}`, pmid: p.pmid, issue_id: `TEST-${p.reference_date}`,
  topic_id: `test-topic-${i}`, topic_label: p.topics, delivered_date: p.reference_date,
  title_at_delivery: p.title, selection: p.pmid === '2' ? '候補表のみ' : '選定論文',
  summary_ja: p.pmid === '2' ? '' : '【TEST架空】配信時点の日本語要約を保存する欄です。\nこの文章は表示試験用であり、医学的な内容や研究結果を示していません。',
  one_line_assessment: p.pmid === '2' ? '【TEST架空】候補表に保存されていた一行評価の表示例です。' : '',
  why_important: '【TEST架空】保存済み評価理由をそのまま表示する試験です。', importance: 'TEST・評価なし',
  source_kind: 'synthetic_fixture', source_ref: 'phase0_pmid_ledger/fixtures.mjs', current_doc_url: currentDoc
}));
appearances.push({ ...appearances[0], snapshot_id: 'test-snapshot-1-earlier', issue_id: 'TEST-2026-06-01',
  delivered_date: '2026-06-01', title_at_delivery: '【TEST架空】以前の配信時タイトル',
  summary_ja: '【TEST架空】6月配信の表示試験用要約。8月の要約とは別の掲載履歴として残ります。' });
export const settings = [['key', 'value'], ['environment', 'PHASE0_TEST'], ['instance_id', instance]];
