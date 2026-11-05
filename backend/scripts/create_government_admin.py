"""Create or update the government admin account.

Usage (run from the backend folder, password passed as an environment variable):
    set SOLARSENSE_ADMIN_PASSWORD=your-strong-password
    python scripts/create_government_admin.py info.zerolproductions@gmail.com "Government Admin"

The password is never stored in a file. Rotate it after first use.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text
from werkzeug.security import generate_password_hash

from database import Base, engine, ensure_user_role_columns


def main():
    if len(sys.argv) < 2:
        print("Usage: create_government_admin.py <email> [full name]")
        return 1

    email = sys.argv[1].strip().lower()
    full_name = sys.argv[2].strip() if len(sys.argv) > 2 else "Government Admin"
    password = os.getenv("SOLARSENSE_ADMIN_PASSWORD", "")

    if len(password) < 8:
        print("Set SOLARSENSE_ADMIN_PASSWORD to a password of at least 8 characters first.")
        return 1

    Base.metadata.create_all(bind=engine)
    ensure_user_role_columns()

    with engine.begin() as connection:
        existing = connection.execute(
            text("SELECT id FROM app_users WHERE email = :email"),
            {"email": email},
        ).mappings().first()

        if existing:
            connection.execute(
                text("""
                    UPDATE app_users
                    SET password_hash = :password_hash, role = 'government_admin',
                        status = 'active', requested_role = NULL, full_name = :full_name
                    WHERE id = :id
                """),
                {"password_hash": generate_password_hash(password), "full_name": full_name, "id": existing["id"]},
            )
            user_id = existing["id"]
            action = "admin_updated"
        else:
            user_id = connection.execute(
                text("""
                    INSERT INTO app_users (full_name, email, password_hash, role, status)
                    VALUES (:full_name, :email, :password_hash, 'government_admin', 'active')
                    RETURNING id
                """),
                {"full_name": full_name, "email": email, "password_hash": generate_password_hash(password)},
            ).scalar_one()
            action = "admin_created"

        connection.execute(
            text("""
                INSERT INTO audit_logs (actor_user_id, action, target, detail)
                VALUES (NULL, :action, :target, 'Created or updated by the bootstrap script')
            """),
            {"action": action, "target": str(user_id)},
        )

    print("Government admin is ready for", email)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
