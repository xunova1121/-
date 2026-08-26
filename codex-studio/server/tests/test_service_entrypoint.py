import sys

import run_service
from app.config import app_data_dir


def test_prepare_headless_streams_keeps_existing_streams():
    stdout, stderr = sys.stdout, sys.stderr
    run_service.prepare_headless_streams()
    assert sys.stdout is stdout
    assert sys.stderr is stderr


def test_development_data_directory_is_inside_server():
    assert app_data_dir().name == "data"
