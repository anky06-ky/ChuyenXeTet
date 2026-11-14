import os

import pytest

os.environ["TETLIVE_NO_AUTOCONNECT"] = "1"


@pytest.fixture(autouse=True)
def _isolate_tiktok_autoconnect(monkeypatch):
    monkeypatch.setenv("TETLIVE_NO_AUTOCONNECT", "1")
