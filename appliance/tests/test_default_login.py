"""Factory SSH user is admin; first login must change the password."""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class DefaultLoginTests(unittest.TestCase):
    def test_cloud_init_user_is_admin_only(self) -> None:
        text = (ROOT / "deploy" / "cloud-init" / "user-data").read_text(encoding="utf-8")
        self.assertIn("\n  - name: admin\n", text)
        self.assertEqual(text.count("\n  - name:"), 1)
        self.assertIn("plain_text_passwd: maskclaw", text)
        self.assertNotIn("expire: true", text)
        self.assertNotIn("chpasswd:", text)
        self.assertIn("sudo: ALL=(ALL) ALL", text)
        self.assertNotIn("NOPASSWD", text)
        self.assertNotIn("C:\\Users\\", text)
        self.assertIn("passwd", text)
        self.assertIn("/etc/motd", text)
        self.assertIn("/etc/profile.d/maskclaw-passwd-hint.sh", text)

    def test_install_ensures_admin_and_force_passwd(self) -> None:
        text = (ROOT / "deploy" / "install.sh").read_text(encoding="utf-8")
        self.assertIn("useradd -m -s /bin/bash admin", text)
        self.assertIn("admin:maskclaw", text)
        self.assertNotIn("chage -d 0 admin", text)
        self.assertNotIn(".factory-ssh-expire", text)
        self.assertIn(".factory-ssh-pending", text)
        self.assertIn(".factory-ssh-seeded", text)
        self.assertIn("/etc/profile.d/maskclaw-force-passwd.sh", text)
        self.assertIn("setup.token", text)
        self.assertIn("Dashboard setup token", text)
        self.assertIn("/etc/motd", text)
        self.assertIn("passwd", text)
        self.assertEqual(text.count("useradd"), 1)
        self.assertNotIn("C:\\Users\\", text)


if __name__ == "__main__":
    unittest.main()
