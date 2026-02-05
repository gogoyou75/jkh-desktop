import os
import sys
import json
import time
import socket
import subprocess
import webbrowser
from pathlib import Path

def app_root():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent

def ensure_dir(p: Path):
    p.mkdir(parents=True, exist_ok=True)

def load_config(root: Path):
    cfg_path = root / "config" / "app.json"
    if cfg_path.exists():
        try:
            return json.loads(cfg_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "host": "127.0.0.1",
        "port": 8765,
        "open_browser": True,
        "health_path": "/api/health",
        "threads": 6
    }

def port_free(host: str, port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.settimeout(0.3)
        return s.connect_ex((host, port)) != 0
    finally:
        try:
            s.close()
        except Exception:
            pass

def wait_health(url: str, timeout_sec: int = 25) -> bool:
    import urllib.request
    start = time.time()
    while time.time() - start < timeout_sec:
        try:
            with urllib.request.urlopen(url, timeout=1.5) as r:
                if 200 <= getattr(r, "status", 200) < 300:
                    return True
        except Exception:
            time.sleep(0.4)
    return False

def run_server(root: Path, host: str, port: int, threads: int):
    os.chdir(str(root))
    from waitress import serve
    from app.server import create_app
    app = create_app(root_path=str(root))
    serve(app, host=host, port=port, threads=int(threads))

def start_server_process(root: Path, host: str, port: int, threads: int) -> subprocess.Popen:
    logs_dir = root / "logs"
    ensure_dir(logs_dir)
    out_f = open(logs_dir / "server_out.log", "w", encoding="utf-8", errors="ignore")
    err_f = open(logs_dir / "server_err.log", "w", encoding="utf-8", errors="ignore")

    if getattr(sys, "frozen", False):
        cmd = [sys.executable, "--server", "--host", host, "--port", str(port), "--threads", str(threads)]
    else:
        cmd = [sys.executable, str(root / "launcher.py"), "--server", "--host", host, "--port", str(port), "--threads", str(threads)]

    creationflags = 0x08000000 if os.name == "nt" else 0
    return subprocess.Popen(cmd, cwd=str(root), stdout=out_f, stderr=err_f, creationflags=creationflags)

def parse_args(argv):
    d = {"server": False, "host": None, "port": None, "threads": None}
    it = iter(range(len(argv)))
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--server":
            d["server"] = True
        elif a == "--host" and i + 1 < len(argv):
            d["host"] = argv[i + 1]; i += 1
        elif a == "--port" and i + 1 < len(argv):
            d["port"] = int(argv[i + 1]); i += 1
        elif a == "--threads" and i + 1 < len(argv):
            d["threads"] = int(argv[i + 1]); i += 1
        i += 1
    return d

def main():
    root = app_root()
    ensure_dir(root / "data")
    ensure_dir(root / "logs")
    ensure_dir(root / "backups")
    ensure_dir(root / "config")

    cfg = load_config(root)
    host = cfg.get("host", "127.0.0.1")
    port = int(cfg.get("port", 8765))
    threads = int(cfg.get("threads", 6))
    health_path = cfg.get("health_path", "/api/health")

    # КРИТИЧЕСКИ: фиксированный порт -> стабильный localStorage (роли/логин не "слетают")
    if not port_free(host, port):
        msg = f"Порт {host}:{port} занят. Закрой предыдущий JKH.exe или освободи порт и запусти снова."
        try:
            import tkinter as tk
            from tkinter import messagebox
            r = tk.Tk(); r.withdraw()
            messagebox.showerror("JKH", msg)
            r.destroy()
        except Exception:
            pass
        print(msg)
        return 1

    p = start_server_process(root, host, port, threads)

    health_url = f"http://{host}:{port}{health_path}"
    if not wait_health(health_url, timeout_sec=30):
        try:
            import tkinter as tk
            from tkinter import messagebox
            r = tk.Tk(); r.withdraw()
            messagebox.showerror("JKH", "Сервер не запустился. Смотри logs/server_err.log")
            r.destroy()
        except Exception:
            pass
        try:
            p.terminate()
        except Exception:
            pass
        return 1

    if cfg.get("open_browser", True):
        webbrowser.open(f"http://{host}:{port}/")

    try:
        while p.poll() is None:
            time.sleep(0.8)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            if p.poll() is None:
                p.terminate()
        except Exception:
            pass
    return 0

if __name__ == "__main__":
    args = parse_args(sys.argv[1:])
    root = app_root()
    if args["server"]:
        cfg = load_config(root)
        host = args["host"] or cfg.get("host", "127.0.0.1")
        port = int(args["port"] or cfg.get("port", 8765))
        threads = int(args["threads"] or cfg.get("threads", 6))
        run_server(root, host, port, threads)
    else:
        raise SystemExit(main())
