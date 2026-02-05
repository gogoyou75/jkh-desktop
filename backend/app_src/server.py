import sys
from pathlib import Path
from flask import Flask, send_from_directory, jsonify, abort

def _find_web_dir(root: Path) -> Path:
    # 1) рядом с exe/корнем проекта
    cand = root / "web"
    if (cand / "index.html").exists():
        return cand

    # 2) если PyInstaller распаковал во временную папку (_MEIPASS)
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        cand2 = Path(meipass) / "web"
        if (cand2 / "index.html").exists():
            return cand2

    # 3) fallback: если web существует, но index.html нет (на всякий случай)
    if cand.exists():
        return cand
    if meipass and (Path(meipass) / "web").exists():
        return Path(meipass) / "web"

    return cand  # вернём ожидаемый путь для понятного 404

def create_app(root_path=None):
    root = Path(root_path) if root_path else Path(__file__).resolve().parents[1]

    web_dir = _find_web_dir(root)

    # папки данных
    (root / "data").mkdir(exist_ok=True)
    (root / "logs").mkdir(exist_ok=True)
    (root / "backups").mkdir(exist_ok=True)

    app = Flask(__name__, static_folder=str(web_dir), static_url_path="")

    @app.route("/")
    def index():
        idx = web_dir / "index.html"
        if not idx.exists():
            return "web_index not found", 404
        return send_from_directory(web_dir, "index.html")

    @app.route("/<path:path>")
    def static_files(path):
        f = web_dir / path
        if f.exists():
            return send_from_directory(web_dir, path)
        abort(404)

    @app.route("/api/health")
    def health():
        return jsonify({
            "status": "ok",
            "root": str(root),
            "web_dir": str(web_dir),
            "index_exists": (web_dir / "index.html").exists(),
            "frozen": bool(getattr(sys, "frozen", False)),
            "meipass": getattr(sys, "_MEIPASS", None)
        })

    return app
