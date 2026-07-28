import unittest
from unittest.mock import MagicMock, call

from automation_core import load_config
from automation_services import GoogleWorkspaceClient
from pubmed_automation import DriveStore, maybe_notify


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


class DriveLookupTests(unittest.TestCase):
    def test_find_child_returns_none_when_drive_search_is_empty(self):
        client = GoogleWorkspaceClient.__new__(GoogleWorkspaceClient)
        client.drive = MagicMock()
        client.drive.files.return_value.list.return_value.execute.return_value = {"files": []}

        result = client.find_child("parent", "missing")

        self.assertIsNone(result)


class DocumentFolderTests(unittest.TestCase):
    def test_only_archive_and_current_folders_are_created(self):
        store = DriveStore.__new__(DriveStore)
        store.documents_id = "documents"
        store.google = MagicMock()
        store.google.ensure_folder.side_effect = [
            "topic-folder",
            "archive-folder",
            "current-folder",
        ]

        result = store.document_folders("topic")

        self.assertEqual(result, {
            "archive": "archive-folder",
            "current": "current-folder",
        })
        self.assertEqual(store.google.ensure_folder.call_args_list, [
            call("documents", "topic"),
            call("topic-folder", "archive"),
            call("topic-folder", "current"),
        ])


if __name__ == "__main__":
    unittest.main()
