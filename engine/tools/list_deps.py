"""Resolve engine dependencies, including requested extras and environment markers."""
import json
import sys
import os
import platform
from collections import deque
from importlib import metadata

try:
    from packaging.requirements import Requirement
    from packaging.markers import default_environment
except ImportError:
    from pip._vendor.packaging.requirements import Requirement
    from pip._vendor.packaging.markers import default_environment

def norm(name):
    return name.lower().replace("_", "-").replace(".", "-")

EXCLUDE = {"pip", "setuptools", "wheel", "pytest", "pyinstaller"}

env = default_environment()
env["sys_platform"] = sys.platform
env["platform_system"] = platform.system()

queue = deque()
for arg in sys.argv[1:]:
    req = Requirement(arg)
    queue.append((norm(req.name), set(req.extras)))

seen = {}
order = []

while queue:
    name, extras = queue.popleft()
    if name in EXCLUDE:
        continue

    if name not in seen:
        try:
            seen[name] = metadata.distribution(name)
            order.append(seen[name])
        except metadata.PackageNotFoundError:
            seen[name] = None

    dist = seen[name]
    if dist is None:
        continue

    marker_extras = extras or {""}
    for raw in dist.requires or []:
        req = Requirement(raw)

        if req.marker is not None:
            if not any(req.marker.evaluate({**env, "extra": extra}) for extra in marker_extras):
                continue

        queue.append((norm(req.name), set(req.extras)))

out = {
    "python": sys.version.split()[0],
    "missing": [name for name, dist in seen.items() if dist is None],
    "dists": []
}

for dist in order:
    base = str(dist.locate_file(""))
    files = []

    for item in dist.files or []:
        rel = str(item).replace("\\", "/")
        if rel.endswith(".pyc") or "/__pycache__/" in rel:
            continue
        if rel.startswith(("..", "/")) or os.path.isabs(rel):
            continue
        files.append(rel)

    out["dists"].append({
        "name": dist.metadata["Name"],
        "version": dist.version,
        "base": base,
        "files": files
    })

print(json.dumps(out))
