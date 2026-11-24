"""PythonAnywhere Manual Configuration WSGI entry point."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / "luoban"))
from server.app import create_app
from server.host_config import SETTINGS

application = create_app(json.loads(SETTINGS.read_text()))
