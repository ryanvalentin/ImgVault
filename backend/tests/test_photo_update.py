import asyncio
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def setUpModule():
    global temp_dir, environment, database, main
    temp_dir = tempfile.TemporaryDirectory()
    root = Path(temp_dir.name)
    environment = patch.dict(os.environ, {
        "DB_PATH": str(root / "photos.db"),
        "PHOTOS_DIR": str(root / "photos"),
        "TRANSCODE_DIR": str(root / "transcoded"),
        "CONVERT_DIR": str(root / "converted"),
        "TRASH_DIR": str(root / "trash"),
    })
    environment.start()
    database = importlib.import_module("database")
    main = importlib.import_module("main")


def tearDownModule():
    environment.stop()
    temp_dir.cleanup()


async def request(method, path, body=None):
    payload = json.dumps(body).encode() if body is not None else b""
    messages = []
    received = False

    async def receive():
        nonlocal received
        if not received:
            received = True
            return {"type": "http.request", "body": payload, "more_body": False}
        await asyncio.Event().wait()

    async def send(message):
        messages.append(message)

    await main.app({
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(b"content-type", b"application/json")],
        "server": ("test", 80),
        "client": ("test", 1234),
    }, receive, send)
    status = next(message["status"] for message in messages if message["type"] == "http.response.start")
    content = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return status, json.loads(content)


class PhotoUpdateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.db_path = patch.object(database, "DB_PATH", str(root / "photos.db"))
        self.photos_dir = patch.object(main, "PHOTOS_DIR", str(root))
        self.db_path.start()
        self.photos_dir.start()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.db_path.stop)
        self.addCleanup(self.photos_dir.stop)
        database.init_db()
        (root / "photo.jpg").touch()
        conn = database.get_db()
        with conn:
            conn.execute(
                "INSERT INTO photos (id, filename, path, folder, camera, location) VALUES (?, ?, ?, ?, ?, ?)",
                ("photo-1", "photo.jpg", "photo.jpg", "Root", "Old camera", "Old location"),
            )
        conn.close()

    def call(self, method, path, body=None):
        return asyncio.run(request(method, path, body))

    def test_updates_all_allowed_fields_and_get_and_search_see_them(self):
        updates = {
            "width": 1200, "height": 800, "date_taken": "2025-01-02T03:04:05",
            "location": "New place", "camera": "New camera", "lens": "Lens",
            "iso": 200, "aperture": "f/2.8", "shutter_speed": "1/100",
            "gps_lat": 51.5, "gps_lng": -0.12, "country": "UK", "city": "London",
        }
        status, result = self.call("PATCH", "/api/photos/photo-1", updates)
        self.assertEqual(status, 200)
        for field, value in updates.items():
            self.assertEqual(result[field], value)
        self.assertEqual(result["filename"], "photo.jpg")
        status, fetched = self.call("GET", "/api/photos/photo-1")
        self.assertEqual(status, 200)
        self.assertEqual(result, fetched)
        photos, total = database.search_photos(query="New place")
        self.assertEqual(total, 1)
        self.assertEqual(photos[0]["id"], "photo-1")
        self.assertEqual(database.get_map_photos()[0]["city"], "London")

    def test_partial_update_and_explicit_null(self):
        status, result = self.call("PATCH", "/api/photos/photo-1", {"location": None, "gps_lat": 0})
        self.assertEqual(status, 200)
        self.assertIsNone(result["location"])
        self.assertEqual(result["gps_lat"], 0)
        self.assertEqual(result["camera"], "Old camera")

    def test_rejects_unknown_immutable_empty_and_invalid_values(self):
        for body in (
            {}, {"filename": "other.jpg"}, {"file_hash": "changed"},
            {"location": "new", "id": "other"}, {"unknown": "value"},
            {"gps_lat": 91}, {"gps_lng": -181}, {"width": -1},
            {"iso": "not a number"},
        ):
            with self.subTest(body=body):
                status, _ = self.call("PATCH", "/api/photos/photo-1", body)
                self.assertEqual(status, 422)
        self.assertEqual(database.get_photo_by_id("photo-1")["location"], "Old location")

    def test_missing_photo_returns_404(self):
        status, result = self.call("PATCH", "/api/photos/missing", {"camera": "Camera"})
        self.assertEqual(status, 404)
        self.assertEqual(result["detail"], "Photo not found")

    def test_database_helper_rejects_untrusted_column_names(self):
        with self.assertRaises(ValueError):
            database.update_photo_metadata("photo-1", {"filename": "other.jpg"})

    def test_request_fields_match_database_allowlist(self):
        self.assertEqual(set(main.UpdatePhotoRequest.model_fields), database.PHOTO_METADATA_FIELDS)

    def test_reindex_preserves_manually_edited_fields_and_refreshes_others(self):
        self.call("PATCH", "/api/photos/photo-1", {"camera": "Manual", "location": None, "gps_lat": 0})
        self.call("PATCH", "/api/photos/photo-1", {"city": "Manual city"})
        indexed = database.get_photo_by_id("photo-1")
        indexed.update(camera="EXIF camera", location="EXIF location", gps_lat=40.0,
                       city="EXIF city", lens="New lens", file_hash="new hash")
        database.upsert_photos_batch([indexed])
        updated = database.get_photo_by_id("photo-1")
        self.assertEqual(updated["camera"], "Manual")
        self.assertIsNone(updated["location"])
        self.assertEqual(updated["gps_lat"], 0)
        self.assertEqual(updated["city"], "Manual city")
        self.assertEqual(updated["lens"], "New lens")
        self.assertEqual(updated["file_hash"], "new hash")

    def test_all_editable_fields_are_protected_on_single_and_batch_upsert(self):
        manual = {
            "width": 1, "height": None, "date_taken": "2020-01-01T12:00:00",
            "location": "Manual", "camera": "Manual camera", "lens": "Manual lens",
            "iso": 0, "aperture": "f/4", "shutter_speed": "1/10",
            "gps_lat": 0, "gps_lng": -1, "country": "Manual country", "city": "Manual city",
        }
        self.call("PATCH", "/api/photos/photo-1", manual)
        indexed = database.get_photo_by_id("photo-1")
        indexed.update({field: None for field in manual})
        indexed.pop("manual_fields")
        for upsert in (database.upsert_photo, lambda photo: database.upsert_photos_batch([photo])):
            upsert(indexed)
            actual = database.get_photo_by_id("photo-1")
            for field, value in manual.items():
                self.assertEqual(actual[field], value, field)
            self.assertEqual(set(json.loads(actual["manual_fields"])), set(manual))

    def test_force_full_index_preserves_manual_edits(self):
        self.call("PATCH", "/api/photos/photo-1", {"camera": "Manual"})
        indexed = database.get_photo_by_id("photo-1")
        indexed.update(camera="EXIF camera", lens="New lens")
        indexed.pop("manual_fields")
        with patch.object(main, "_process_single_file", return_value=indexed):
            main.run_indexer(force_full=True)
        updated = database.get_photo_by_id("photo-1")
        self.assertEqual(updated["camera"], "Manual")
        self.assertEqual(updated["lens"], "New lens")

    def test_migration_adds_tracking_columns_without_changing_existing_photos(self):
        conn = database.get_db()
        with conn:
            conn.execute("ALTER TABLE photos DROP COLUMN manual_fields")
            conn.execute("ALTER TABLE trash DROP COLUMN manual_fields")
            conn.execute("ALTER TABLE trash DROP COLUMN country")
            conn.execute("ALTER TABLE trash DROP COLUMN city")
        conn.close()
        database.init_db()
        database.init_db()
        photo = database.get_photo_by_id("photo-1")
        self.assertEqual(photo["camera"], "Old camera")
        self.assertEqual(json.loads(photo["manual_fields"]), [])
        conn = database.get_db()
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(trash)")}
        conn.close()
        self.assertTrue({"manual_fields", "country", "city"} <= columns)

    def test_trash_restore_keeps_edits_through_reindex(self):
        trash = Path(self.directory.name) / "trash"
        trash.mkdir()
        with patch.object(main, "TRASH_DIR", str(trash)):
            self.call("PATCH", "/api/photos/photo-1", {"country": "Manual country", "camera": "Manual"})
            self.assertEqual(self.call("POST", "/api/photos/delete", {"ids": ["photo-1"]})[0], 200)
            self.assertEqual(self.call("POST", "/api/trash/restore", {"ids": ["photo-1"]})[0], 200)
            restored = database.get_photo_by_id("photo-1")
            self.assertEqual(restored["country"], "Manual country")
            restored.update(camera="EXIF", country="Geocoded")
            database.upsert_photo(restored)
            self.assertEqual(database.get_photo_by_id("photo-1")["camera"], "Manual")
            self.assertEqual(database.get_photo_by_id("photo-1")["country"], "Manual country")


if __name__ == "__main__":
    unittest.main()
