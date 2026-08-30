"""Separate CLI: dry-run by default; no imports of the AI pipeline."""
import argparse
import json
import os
from pathlib import Path
from .core import Dataset, canonical
from .migrate import collect_local, collect_drive


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["inventory", "create", "sync", "backup", "restore-copy"])
    parser.add_argument("--backup-file")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument("--drive-root", default=os.environ.get("GOOGLE_DRIVE_ROOT_FOLDER_ID", ""))
    parser.add_argument("--sheet-id", default=os.environ.get("PMID_LEDGER_SHEET_ID", ""))
    parser.add_argument("--instance", default="pubmed-review-production-v1")
    parser.add_argument("--title", default="PMID論文確認台帳")
    parser.add_argument("--include-drive", action="store_true")
    parser.add_argument("--include-docs", action="store_true")
    parser.add_argument("--output", default="ledger_private")
    args = parser.parse_args()
    if args.command == "sync" and (not args.sheet_id or not args.include_drive):
        parser.error("sync requires --sheet-id and --include-drive")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    google = None
    if args.include_drive or args.command != "inventory":
        from .google_store import GoogleStore
        google = GoogleStore(str(Path(args.root) / "google_authorized_user.json"))
    if args.command == "create":
        if not args.drive_root:
            parser.error("--drive-root is required")
        print(json.dumps({"sheet_id": google.create(args.drive_root, args.title, args.instance), "owner": google.identity()}))
        return
    if args.command == "restore-copy":
        if not args.backup_file or not args.drive_root or args.instance == "pubmed-review-production-v1" or args.title == "PMID論文確認台帳":
            parser.error("restore-copy requires --backup-file, --drive-root, and a NEW --title / --instance")
        result = google.restore_copy(json.loads(Path(args.backup_file).read_text()), args.drive_root, args.title, args.instance)
        print(json.dumps({"restored_sheet_id":result}))
        return
    if args.command == "backup":
        tables = google.read(args.sheet_id, args.instance)
        destination = output / "backup.json"
        destination.write_text(canonical({"schema": "PMID_LEDGER_V1", "instance": args.instance, "tables": tables}), encoding="utf-8")
        destination.chmod(0o600)
        print(str(destination))
        return
    config = json.loads((Path(args.root)/"automation_config.json").read_text())
    aliases = {k:v["display_name"] for k,v in config["topics"].items()}
    aliases.update({"気管支喘息":"小児喘息", "プライマリケアレビュー":"プライマリケア・レビュー", "小児プライマリケア":"小児プライマリケア高インパクト", "小児ワクチン":"ワクチン", "便秘":"小児便秘", "小児外傷":"小児外傷等"})
    data = Dataset(aliases)
    # Drive metadata has priority over recovered display titles; no manual state is read here.
    if args.include_drive:
        if not args.drive_root:
            parser.error("--drive-root is required")
        collect_drive(google, args.drive_root, data, args.include_docs, progress=lambda message: print(message, flush=True))
    collect_local(Path(args.root), data)
    for name, value in (("inventory.json", data.payload()), ("report.json", data.report())):
        destination = output / name
        destination.write_text(canonical(value), encoding="utf-8")
        destination.chmod(0o600)
    print(json.dumps({k: v for k, v in data.report().items() if k not in ("sources", "warnings")}, ensure_ascii=False))
    if args.command == "sync":
        # Serialize local invocations. Actions uses the shared workflow concurrency group.
        import fcntl
        with (output / "sync.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print(json.dumps(google.publish(args.sheet_id, args.instance, data.payload(), output / "backups")))


if __name__ == "__main__":
    main()
