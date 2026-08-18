import unittest
from unittest.mock import MagicMock, call

from automation_core import load_config
from automation_services import GoogleWorkspaceClient, split_score_table
from pubmed_automation import DriveStore, create_documents, maybe_notify


class FailingGoogle:
    def send_email(self, *_args, **_kwargs):
        raise RuntimeError("temporary gmail failure")


class FakeStore:
    def __init__(self):
        self.google = FailingGoogle()
        self.save_count = 0

    def save_ledger(self, _ledger):
        self.save_count += 1


class NotificationFailureTests(unittest.TestCase):
    def test_gmail_failure_does_not_roll_back_document_state(self):
        config = load_config("automation_config.json")
        cycle = {
            "cycle_id": "cycle",
            "test": False,
            "notification": {"state": "PENDING", "attempts": 0, "message_id": None},
        }
        manifest = {
            "display_name": "小児腎臓",
            "state": "COMPLETED",
            "article_count": 5,
            "selected_count": 5,
            "failed_pmids": [],
            "components": {
                "archive_doc": {"state": "COMPLETED", "url": "archive"},
                "current_doc": {"state": "COMPLETED", "url": "current"},
            },
        }
        store = FakeStore()
        maybe_notify(store, {"cycles": {"cycle": cycle}}, cycle, [manifest], config)
        self.assertEqual(cycle["notification"]["state"], "NOTIFICATION_FAILED_RETRYABLE")
        self.assertEqual(manifest["components"]["archive_doc"]["state"], "COMPLETED")
        self.assertEqual(manifest["state"], "COMPLETED")
        self.assertEqual(store.save_count, 1)


class CurrentDocumentIdempotencyTests(unittest.TestCase):
    def test_existing_document_is_updated_without_creating_a_new_file(self):
        client = GoogleWorkspaceClient.__new__(GoogleWorkspaceClient)
        client.find_child = MagicMock(return_value={
            "id": "fixed-current-id",
            "name": "小児腎臓_NotebookLM_CURRENT",
            "webViewLink": "https://docs.google.com/document/d/fixed-current-id/edit",
        })
        client.replace_doc_text = MagicMock()
        client.drive = MagicMock()
        result = client.create_doc("folder", "小児腎臓_NotebookLM_CURRENT", "latest")
        self.assertEqual(result["id"], "fixed-current-id")
        client.replace_doc_text.assert_called_once_with("fixed-current-id", "latest")
        client.drive.files.return_value.create.assert_not_called()


class NativeScoreTableTests(unittest.TestCase):
    def test_score_section_is_split_into_five_column_rows(self):
        text = (
            "【第1部：日本語要約】\n本文\n\n"
            "【第3部：候補論文スコア一覧】\n\n"
            "PMID | タイトル | 総合スコア | 役立つか | 短いメモ\n"
            "123 | A title | 18 | Yes (4/5) | useful"
        )

        body, rows = split_score_table(text)

        self.assertEqual(body, "【第1部：日本語要約】\n本文\n\n【第3部：候補論文スコア一覧】\n")
        self.assertEqual(rows, [
            ["PMID", "タイトル", "総合スコア", "役立つか", "短いメモ"],
            ["123", "A title", "18", "Yes (4/5)", "useful"],
        ])

    def test_replace_doc_text_creates_and_populates_native_table(self):
        client = GoogleWorkspaceClient.__new__(GoogleWorkspaceClient)
        client.docs = MagicMock()
        empty_table = {
            "startIndex": 25,
            "table": {
                "tableRows": [
                    {"tableCells": [
                        {"content": [{"startIndex": 30 + row * 20 + column * 3}]}
                        for column in range(5)
                    ]}
                    for row in range(2)
                ]
            },
        }
        populated_table = {
            "startIndex": 25,
            "table": {
                "tableRows": [
                    {"tableCells": [
                        {"content": [{"paragraph": {"elements": [{
                            "textRun": {"content": value + "\n"}
                        }]}}]}
                        for value in row
                    ]}
                    for row in [
                        ["PMID", "タイトル", "総合スコア", "役立つか", "短いメモ"],
                        ["123", "A title", "18", "Yes (4/5)", "useful"],
                    ]
                ]
            },
        }
        client.docs.documents.return_value.get.return_value.execute.side_effect = [
            {"body": {"content": [{"endIndex": 8}]}},
            {"body": {"content": [empty_table]}},
            {"body": {"content": [populated_table]}},
        ]
        text = (
            "【第3部：候補論文スコア一覧】\n\n"
            "PMID | タイトル | 総合スコア | 役立つか | 短いメモ\n"
            "123 | A title | 18 | Yes (4/5) | useful"
        )

        client.replace_doc_text("doc-id", text)

        updates = client.docs.documents.return_value.batchUpdate.call_args_list
        first_requests = updates[0].kwargs["body"]["requests"]
        self.assertIn("insertTable", first_requests[-1])
        self.assertEqual(first_requests[-1]["insertTable"]["rows"], 2)
        self.assertEqual(first_requests[-1]["insertTable"]["columns"], 5)
        table_requests = updates[1].kwargs["body"]["requests"]
        self.assertEqual(sum("insertText" in request for request in table_requests), 10)
        style_requests = updates[2].kwargs["body"]["requests"]
        style = style_requests[0]["updateTableCellStyle"]
        self.assertNotIn("tableStartLocation", style)
        self.assertEqual(
            style["tableRange"]["tableCellLocation"]["tableStartLocation"],
            {"index": 25},
        )
        self.assertIn("pinTableHeaderRows", style_requests[1])

    def test_population_is_verified_before_table_styling(self):
        client = GoogleWorkspaceClient.__new__(GoogleWorkspaceClient)
        client.docs = MagicMock()
        empty_table = {
            "startIndex": 25,
            "table": {"tableRows": [
                {"tableCells": [{"content": [{"startIndex": 30 + row * 20 + col * 3}]} for col in range(5)]}
                for row in range(2)
            ]},
        }
        client.docs.documents.return_value.get.return_value.execute.side_effect = [
            {"body": {"content": [{"endIndex": 8}]}},
            {"body": {"content": [empty_table]}},
            {"body": {"content": [empty_table]}},
        ]
        text = (
            "【第3部：候補論文スコア一覧】\n\n"
            "PMID | タイトル | 総合スコア | 役立つか | 短いメモ\n"
            "123 | A title | 18 | Yes (4/5) | useful"
        )

        with self.assertRaisesRegex(RuntimeError, "全データ"):
            client.replace_doc_text("doc-id", text)

        self.assertEqual(
            client.docs.documents.return_value.batchUpdate.call_count,
            2,
        )


class DriveLookupTests(unittest.TestCase):
    def test_find_child_returns_none_when_drive_search_is_empty(self):
        client = GoogleWorkspaceClient.__new__(GoogleWorkspaceClient)
        client.drive = MagicMock()
        client.drive.files.return_value.list.return_value.execute.return_value = {"files": []}

        result = client.find_child("parent", "missing")

        self.assertIsNone(result)


class DocumentFolderTests(unittest.TestCase):
    def test_only_current_folder_is_created(self):
        store = DriveStore.__new__(DriveStore)
        store.documents_id = "documents"
        store.google = MagicMock()
        store.google.ensure_folder.side_effect = [
            "topic-folder",
            "current-folder",
        ]

        result = store.document_folders("topic")

        self.assertEqual(result, {
            "current": "current-folder",
        })
        self.assertEqual(store.google.ensure_folder.call_args_list, [
            call("documents", "topic"),
            call("topic-folder", "current"),
        ])


class IntegratedDocumentTests(unittest.TestCase):
    def test_create_documents_creates_only_one_integrated_google_doc(self):
        store = MagicMock()
        store.load_json.side_effect = [
            {
                "articles": [{
                    "pmid": "1",
                    "title": "Title 1",
                    "abstract": "FULL ABSTRACT",
                    "journal": "Journal",
                    "year": "2026",
                    "month": "Jul",
                }]
            },
            [{
                "pmid": "1",
                "title": "Title 1",
                "total_score": 20,
                "outpatient_usefulness": 5,
                "one_line_assessment": "重要",
            }],
            {
                "selection_summary": "summary",
                "selected": [{
                    "rank": 1,
                    "pmid": "1",
                    "title": "Title 1",
                    "why_important": "重要です",
                    "clinical_impact": "影響します",
                    "practice_change_needed": "Yes",
                }],
                "alternates": [],
            },
        ]
        store.document_folders.return_value = {"current": "current-folder"}
        store.google.create_doc.return_value = {
            "id": "integrated-id",
            "webViewLink": "https://docs.google.com/document/d/integrated-id/edit",
        }
        store.google.get_file.return_value = {
            "id": "integrated-id",
            "webViewLink": "https://docs.google.com/document/d/integrated-id/edit",
        }
        ledger = {
            "topics": {
                "topic": {
                    "current_file_id": None,
                }
            }
        }
        manifest = {
            "topic": "topic",
            "display_name": "テーマ",
            "run_id": "run",
            "test": False,
            "artifacts": {
                "all_abstracts": {"file_id": "raw"},
                "screen_evaluations": {"file_id": "scores"},
                "final_evaluation": {"file_id": "final"},
            },
            "components": {
                "current_doc": {"state": "PENDING", "attempts": 0},
            },
        }
        config = {
            "topics": {
                "topic": {
                    "current_name": "テーマ_NotebookLM_CURRENT",
                }
            }
        }

        create_documents(store, ledger, manifest, config)

        store.google.create_doc.assert_called_once()
        self.assertEqual(
            store.google.create_doc.call_args.args[:2],
            ("current-folder", "テーマ_NotebookLM_CURRENT"),
        )
        uploaded_text = store.google.create_doc.call_args.args[2]
        self.assertIn("【第1部：日本語要約】", uploaded_text)
        self.assertIn("【第2部：英語Abstract】", uploaded_text)
        self.assertIn("FULL ABSTRACT", uploaded_text)
        self.assertIn("【第3部：候補論文スコア一覧】", uploaded_text)


if __name__ == "__main__":
    unittest.main()
