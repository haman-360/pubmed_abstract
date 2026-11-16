# 一次スクリーニング Luna／Terra 比較TEST（2026-11-17、中間結果）

## 結論と完了範囲

小児腎臓63本、プライマリケア45本の2テーマ（延べ108本）は両群の一次・最終評価が完了。最終10本は各テーマ8本が共通だった。Terra群は抄録から確実に言える範囲にやや慎重な採点だったが、今回の結果だけでは重要論文の取りこぼしが減ったとは断定できない。費用は一次が約8.47倍、最終を含む2テーマ合計が約2.01倍。現時点で本番切替を積極的に支持するほどの明確な品質差は確認できない。

小児喘息48本はTerra群の一次・最終が完了し、Luna群の一次Batchがsnapshot時点で `in_progress`。このテーマの両群比較と3テーマ総費用は未確定。再開ジョブは継続中。本番設定は一次 `gpt-6-luna / low`、最終 `gpt-6-sol / medium` のままであり、変更していない。

## 実行の証跡

- [初回TEST](https://github.com/haman-360/pubmed_abstract/actions/runs/43884200885)：Batch状態GETのHTTP 504で停止。Macのスリープとの関係はない。保存済みBatch IDと入力から再開した。
- [再開TEST](https://github.com/haman-360/pubmed_abstract/actions/runs/43967231002)：投入済み一次Batchを再送せず回収し、未投入の最終だけを実行。小児喘息Lunaの完了待ち。
- [読み取り専用snapshot](https://github.com/haman-360/pubmed_abstract/actions/runs/43970795299)：成功。新規推論の投入なし。このartifactの `screening_comparison_test.json` を本報告の集計元とした。抄録、入力hash、全スコア、候補、Batch ID、生出力、usageを保存。
- 設定：両群で同じ2026-10-19〜11-15 EDATの全抄録・一次プロンプトを使用。一次は `gpt-6-luna / low` 対 `gpt-6.1-terra / low`。最終は双方 `gpt-6-sol / medium`、候補上位20本＋救済最大4本、選定10本＋次点5本。
- 完了2テーマの一次216/216でPMID・点数の整合を確認。最終4/4で候補内PMID・重複・件数の検証に成功。実論文の品質について独立した専門家の正解ラベルは作成していない。

## 選定の一致と違い

| テーマ | 論文数 | 最終候補の共通数（各24本） | 最終選定の共通数（各10本） |
| --- | ---: | ---: | ---: |
| 小児腎臓 | 63 | 19 | 8 |
| プライマリケア | 45 | 22 | 8 |

### 小児腎臓

- Luna群のみ選定：suPARの系統的レビュー（PMID 42991236）、小児発症SLEの抑うつ症状メタ解析（43022156）。
- Terra群のみ選定：小児糸球体疾患のポドサイト総説（42942308）、小児多発性嚢胞腎・線毛病の遺伝学的総説（42938368）。
- 一次候補から異なったのは、上記のうちsuPAR（Lunaのみ候補）とポドサイト総説（Terraのみ候補）。SLEと嚢胞腎は両群の候補にあり、最終選定の差だった。
- 抄録照合：両モデルともsuPARのルーチン測定を支持しないという限界を把握している。Terraがこれを落としたこと自体を改善とは断定しない。Terra群の追加2本もナラティブレビューで、診療を変える強い新規根拠とは限らない。
- 一次候補ではLunaに小児への直接性が乏しい免疫ゲノム基礎研究（42951975）が残り、Terraには小児の稀な症例報告2本（42919264、42983718）が残った。これらは最終10本には入らなかった。Terraが一律に適切な候補だけを残すという結果ではない。

### プライマリケア

- 両群の1位はRSV予防、2位は若年者のうつ・不安への心理介入の系統的レビュー。
- Luna群のみ選定：女性の生涯にわたる心血管予防の多学会声明（42929102）、親の収監による子どもへの影響・支援（42998890）。
- Terra群のみ選定：小児肥満の食行動評価の個人参加者データメタ解析（42919389）、小児遠隔患者モニタリング総説（42918648）。
- 入れ替わった4本はすべて両群の一次候補に含まれていた。したがって「Lunaが一次で重要論文を見落とし、Terraが救った」という差ではない。Terra群のみの2本はLuna群では次点に残っていた。
- 抄録照合：Terraは心血管声明の小児への具体的適用や、親の収監への支援介入の効果について慎重に採点していた（両論文ともLuna18点、Terra14点）。ただし、追加された食行動評価には外部妥当性の課題、遠隔モニタリングには制度・実装条件の制約があるため、明確な優越性とは評価しない。

## 費用（USD、完了した2テーマ）

| テーマ・群 | 一次 | 最終Sol | 合計 |
| --- | ---: | ---: | ---: |
| 小児腎臓・Luna | 0.007438 | 0.042791 | 0.050229 |
| 小児腎臓・Terra | 0.062504 | 0.045441 | 0.107945 |
| プライマリケア・Luna | 0.005013 | 0.041131 | 0.046144 |
| プライマリケア・Terra | 0.042957 | 0.043202 | 0.086159 |
| **2テーマ・Luna合計** | **0.012451** | **0.083922** | **0.096373** |
| **2テーマ・Terra合計** | **0.105461** | **0.088643** | **0.194104** |

Terraへ変更した場合の2テーマ分の差は **+$0.097731（約2.01倍）**。両群を実行した比較TEST自体の完了2テーマ分は$0.290477。

API応答のusageに[公式Batch単価](https://developers.openai.com/api/docs/pricing)を掛けた推定であり、請求額との突合ではない。100万tokenあたり input / cached / 30m cache write / output は、Luna $0.05 / $0.005 / $0.0625 / $0.25、Terra $0.50 / $0.025 / $0.625 / $2.50、最終Sol $1.00 / $0.10 / $1.25 / $5.00。入力内のcache writeを分離して計算した。

一次の入力は両群とも80,251token、出力はLuna33,567token、Terra25,946token。Terraの出力が約22.7%短かったため、一次費用は通常入出力単価の10倍より小さい約8.47倍になった。最終Solの単価は同じだが、入力候補や出力長によって最終費用にも少し差がある。

小児喘息のTerra群は一次$0.048507、最終$0.043089、計$0.091596。Luna群のusageは未回収なので、上記2テーマ合計に小児喘息を混ぜて比較しない。未回収分の費用をゼロとは扱わない。

## 解釈の限界と判断

- 同一抄録での各群1回の比較であり、繰り返し実行によるばらつきは測定していない。最終入力には一次スコアも渡るため、候補の差・スコアの差・Solの生成の揺れを分離できない。
- 全108本に対する独立した正解ラベルがないため、感度・取りこぼし率や「Terraのほうが医学的に正確」という結論は出せない。
- 完了2テーマではTerraの平均一次点数は低かった（小児腎臓11.11→9.51、プライマリケア13.62→11.87）。慎重な採点傾向はあるが、点数が低いこと自体を品質改善とは扱わない。
- 現時点ではLuna継続が妥当。小児喘息の比較が揃った時点で追記し、必要なら「外来で読む価値が高い」と利用者が判断する論文を基準に確認する。本番切替の判断はまだ行わない。

## 完了2テーマの最終選定一覧

### 小児腎臓

| 順位 | Luna一次 → Sol最終 | Terra一次 → Sol最終 |
| --- | --- | --- |
| 1 | [42982531](https://pubmed.ncbi.nlm.nih.gov/42982531/) Hypertension in Children With Chronic Kidney Disease and Dialysis: State of the Art. | [42974802](https://pubmed.ncbi.nlm.nih.gov/42974802/) Early recognition of paediatric kidney disease in low- and middle-income countries: Clinical red flags and referral strategies for primary care. |
| 2 | [42962281](https://pubmed.ncbi.nlm.nih.gov/42962281/) Australian Standards of Care for Genetic and Genomic Testing in Kidney Disease. | [42982531](https://pubmed.ncbi.nlm.nih.gov/42982531/) Hypertension in Children With Chronic Kidney Disease and Dialysis: State of the Art. |
| 3 | [42998943](https://pubmed.ncbi.nlm.nih.gov/42998943/) What Pediatric and Adult Urologists Should Know About Genetics in CAKUT. | [42977790](https://pubmed.ncbi.nlm.nih.gov/42977790/) Pediatric nephrotic syndrome: a mini-review of genetic diagnostic methods. |
| 4 | [42974802](https://pubmed.ncbi.nlm.nih.gov/42974802/) Early recognition of paediatric kidney disease in low- and middle-income countries: Clinical red flags and referral strategies for primary care. | [42998943](https://pubmed.ncbi.nlm.nih.gov/42998943/) What Pediatric and Adult Urologists Should Know About Genetics in CAKUT. |
| 5 | [42991236](https://pubmed.ncbi.nlm.nih.gov/42991236/) Soluble urokinase plasminogen activator receptor across the kidney-cardiometabolic continuum: a systematic review. | [42962281](https://pubmed.ncbi.nlm.nih.gov/42962281/) Australian Standards of Care for Genetic and Genomic Testing in Kidney Disease. |
| 6 | [43022156](https://pubmed.ncbi.nlm.nih.gov/43022156/) Prevalence of depression in childhood-onset systemic lupus erythematosus: a systematic review and meta-analysis. | [43002221](https://pubmed.ncbi.nlm.nih.gov/43002221/) Neonatal kidney injury: diagnosis, management, and long-term kidney health - the perspective of the European Neonatal Nephrology Working Group. |
| 7 | [43030317](https://pubmed.ncbi.nlm.nih.gov/43030317/) A Narrative Review: Nutrition in Pediatric Nephrology: From Early Kidney Health to Advanced CKD Care. | [43030317](https://pubmed.ncbi.nlm.nih.gov/43030317/) A Narrative Review: Nutrition in Pediatric Nephrology: From Early Kidney Health to Advanced CKD Care. |
| 8 | [42895572](https://pubmed.ncbi.nlm.nih.gov/42895572/) Therapy for kidney vasculitis in children during the acute phase and maintenance: updates and insights from new adult therapies. | [42942308](https://pubmed.ncbi.nlm.nih.gov/42942308/) Podocyte Biology in Pediatric Glomerular Disease: From Slit Diaphragm Assembly to Genotype-Guided Therapy-A Narrative Review. |
| 9 | [42977790](https://pubmed.ncbi.nlm.nih.gov/42977790/) Pediatric nephrotic syndrome: a mini-review of genetic diagnostic methods. | [42938368](https://pubmed.ncbi.nlm.nih.gov/42938368/) Genetic Insights into Pediatric Polycystic Kidney Disease and Overlapping Ciliopathies: A Narrative Review. |
| 10 | [43002221](https://pubmed.ncbi.nlm.nih.gov/43002221/) Neonatal kidney injury: diagnosis, management, and long-term kidney health - the perspective of the European Neonatal Nephrology Working Group. | [42895572](https://pubmed.ncbi.nlm.nih.gov/42895572/) Therapy for kidney vasculitis in children during the acute phase and maintenance: updates and insights from new adult therapies. |

### プライマリケア

| 順位 | Luna一次 → Sol最終 | Terra一次 → Sol最終 |
| --- | --- | --- |
| 1 | [42901195](https://pubmed.ncbi.nlm.nih.gov/42901195/) Effectiveness of respiratory syncytial virus immunisation in practice. | [42901195](https://pubmed.ncbi.nlm.nih.gov/42901195/) Effectiveness of respiratory syncytial virus immunisation in practice. |
| 2 | [42949699](https://pubmed.ncbi.nlm.nih.gov/42949699/) Psychological Interventions in Primary Care for Depressed and Anxious Youth: A Systematic Review and Meta-Analysis. | [42949699](https://pubmed.ncbi.nlm.nih.gov/42949699/) Psychological Interventions in Primary Care for Depressed and Anxious Youth: A Systematic Review and Meta-Analysis. |
| 3 | [42996545](https://pubmed.ncbi.nlm.nih.gov/42996545/) The Role of Preventive Pediatric Dentistry in Oral Health: An Evidence-Based Narrative Review : Short title: Preventive Pediatric Dentistry and Oral Health. | [42974802](https://pubmed.ncbi.nlm.nih.gov/42974802/) Early recognition of paediatric kidney disease in low- and middle-income countries: Clinical red flags and referral strategies for primary care. |
| 4 | [42974802](https://pubmed.ncbi.nlm.nih.gov/42974802/) Early recognition of paediatric kidney disease in low- and middle-income countries: Clinical red flags and referral strategies for primary care. | [43019904](https://pubmed.ncbi.nlm.nih.gov/43019904/) HPV vaccination initiation among preadolescents in Veneto, Italy: associations with chronic conditions and socioeconomic disadvantage. |
| 5 | [42929102](https://pubmed.ncbi.nlm.nih.gov/42929102/) Consensus Guidance for the Female-Specific Prevention and Management of Cardiovascular Disease: A Scientific Statement From the American Heart Association, American Academy of Pediatrics, American College of Obstetricians and Gynecologists, and Society for Maternal-Fetal Medicine. | [43001829](https://pubmed.ncbi.nlm.nih.gov/43001829/) Understanding Relative Energy Deficiency in Sport. |
| 6 | [43019904](https://pubmed.ncbi.nlm.nih.gov/43019904/) HPV vaccination initiation among preadolescents in Veneto, Italy: associations with chronic conditions and socioeconomic disadvantage. | [42919389](https://pubmed.ncbi.nlm.nih.gov/42919389/) Identifying eating behaviour phenotype cut-off scores for childhood obesity: an individual participant data meta-analysis using the Child Eating Behaviour Questionnaire (CEBQ). |
| 7 | [43001829](https://pubmed.ncbi.nlm.nih.gov/43001829/) Understanding Relative Energy Deficiency in Sport. | [42996545](https://pubmed.ncbi.nlm.nih.gov/42996545/) The Role of Preventive Pediatric Dentistry in Oral Health: An Evidence-Based Narrative Review : Short title: Preventive Pediatric Dentistry and Oral Health. |
| 8 | [43014887](https://pubmed.ncbi.nlm.nih.gov/43014887/) Behavioral Health: Integrated Models for Improving Pediatric Care. | [43014887](https://pubmed.ncbi.nlm.nih.gov/43014887/) Behavioral Health: Integrated Models for Improving Pediatric Care. |
| 9 | [42998890](https://pubmed.ncbi.nlm.nih.gov/42998890/) Supporting Children Impacted by Parental Incarceration in Pediatric Primary Care. | [42918648](https://pubmed.ncbi.nlm.nih.gov/42918648/) Clinical applications of remote patient monitoring. |
| 10 | [42947299](https://pubmed.ncbi.nlm.nih.gov/42947299/) Advancing Oral Health Through Multidisciplinary Care Models: A Scoping Review of Collaborative Practices. | [42947299](https://pubmed.ncbi.nlm.nih.gov/42947299/) Advancing Oral Health Through Multidisciplinary Care Models: A Scoping Review of Collaborative Practices. |
