import os
from pathlib import Path


def _unique_existing_roots(candidates):
    seen = set()
    for candidate in candidates:
        if not candidate:
            continue
        try:
            resolved = Path(candidate).resolve()
        except OSError:
            continue
        if resolved in seen:
            continue
        seen.add(resolved)
        yield resolved


def _walk_roots(path):
    path = Path(path).resolve()
    yield path
    yield from path.parents


def _looks_like_project_root(path):
    return (
        (path / "web" / "data.js").is_file()
        and (
            (path / "backend").is_dir()
            or (path / "app.py").is_file()
        )
    )


def project_root():
    here = Path(__file__).resolve()
    roots = []
    for env_name in ("JKH_PROJECT_ROOT", "PROJECT_ROOT"):
        value = os.environ.get(env_name)
        if value:
            roots.append(Path(value))

    roots.extend(_walk_roots(Path.cwd()))
    roots.extend(_walk_roots(here.parent))
    roots.append(Path("/app"))

    for candidate in _unique_existing_roots(roots):
        if _looks_like_project_root(candidate):
            return candidate
    return None


def find_repo_file(*parts):
    root = project_root()
    if root is None:
        return None
    candidate = root.joinpath(*parts)
    if candidate.exists():
        return candidate
    if parts and parts[0] == "backend":
        container_candidate = root.joinpath(*parts[1:])
        if container_candidate.exists():
            return container_candidate
    return None
