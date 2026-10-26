"""`pwd` for platforms that do not ship it, namely Windows.

SearXNG imports ``pwd`` at module scope in ``searx/valkeydb.py``, so the import
fails on Windows even though the limiter is disabled and no Valkey/Redis URL is
configured. The module is never called on that path; the shim exists so the
import succeeds, and the functions behave like the real ones for the one call
site that can still reach them (a Valkey connection that fails).

``os.getuid``/``os.geteuid`` are filled in for the same reason: that call site
passes ``os.getuid()`` to ``getpwuid``. Nothing else in SearXNG uses them.
"""

import os

if not hasattr(os, "getuid"):
    os.getuid = lambda: 0  # noqa: E731 - a stand-in, not a policy
    os.geteuid = lambda: 0  # noqa: E731


class struct_passwd:
    """The attributes Python's real ``pwd.struct_passwd`` exposes."""

    def __init__(self, pw_name, pw_passwd="x", pw_uid=0, pw_gid=0, pw_gecos="", pw_dir="", pw_shell=""):
        self.pw_name = pw_name
        self.pw_passwd = pw_passwd
        self.pw_uid = pw_uid
        self.pw_gid = pw_gid
        self.pw_gecos = pw_gecos
        self.pw_dir = pw_dir
        self.pw_shell = pw_shell

    def __iter__(self):
        return iter((self.pw_name, self.pw_passwd, self.pw_uid, self.pw_gid,
                     self.pw_gecos, self.pw_dir, self.pw_shell))


def getpwuid(uid):
    name = os.environ.get("USERNAME") or os.environ.get("USER") or "unknown"
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME") or ""
    return struct_passwd(name, pw_uid=uid, pw_dir=home)


def getpwnam(name):
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME") or ""
    return struct_passwd(name, pw_dir=home)
