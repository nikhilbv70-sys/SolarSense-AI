from functools import wraps

from flask import g, jsonify, session
from sqlalchemy import text

from database import engine

NORMAL_ROLE = "normal_user"
GOVERNMENT_ROLES = ("government_admin", "department_admin", "district_admin", "plant_operator")
REQUESTABLE_ROLES = ("department_admin", "district_admin", "plant_operator")

HOME_PAGES = {
    NORMAL_ROLE: "/js/index.html",
    "government_admin": "/js/government.html",
    "department_admin": "/js/government.html",
    "district_admin": "/js/government.html",
    "plant_operator": "/js/government.html",
}
PENDING_PAGE = "/js/pending-approval.html"


def load_current_user():
    """Read the signed-in user's role and status from PostgreSQL on every call."""
    user_id = session.get("user_id")
    if not user_id:
        return None
    with engine.connect() as connection:
        return connection.execute(
            text("""
                SELECT id, full_name, email, role, status, requested_role, organisation
                FROM app_users
                WHERE id = :user_id
            """),
            {"user_id": user_id},
        ).mappings().first()


def home_for(user):
    if user["status"] != "active":
        return PENDING_PAGE
    return HOME_PAGES.get(user["role"], HOME_PAGES[NORMAL_ROLE])


def role_response(user):
    return {
        "role": user["role"],
        "status": user["status"],
        "requested_role": user["requested_role"],
        "organisation": user["organisation"],
        "redirect": home_for(user),
    }


def require_roles(*allowed_roles):
    """Allow only active users whose database role is one of allowed_roles."""
    def decorator(view):
        @wraps(view)
        def wrapper(*args, **kwargs):
            user = load_current_user()
            if not user:
                return jsonify({"error": "Sign in to continue."}), 401
            if user["status"] != "active":
                return jsonify({"error": "Your account is waiting for approval."}), 403
            if user["role"] not in allowed_roles:
                return jsonify({"error": "Your account does not have access to this area."}), 403
            g.current_user = user
            return view(*args, **kwargs)
        return wrapper
    return decorator
