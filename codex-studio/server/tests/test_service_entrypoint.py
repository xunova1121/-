import sys

import run_service


def test_prepare_headless_streams_keeps_existing_streams():
    stdout, stderr = sys.stdout, sys.stderr
    run_service.prepare_headless_streams()
    assert sys.stdout is stdout
    assert sys.stderr is stderr
