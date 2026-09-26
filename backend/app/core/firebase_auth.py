"""Firebase Authentication adapter.

When FIREBASE_AUTH_ENABLED=true, verifies Firebase ID tokens from the
Authorization header and maps them to existing User rows (by firebase_uid
or email). Auto-creates a User + personal workspace on first login.

Exports `get_firebase_user` as a FastAPI dependency with the same return
type as fastapi-users' `current_active_user` so downstream code is unchanged.
"""
import json
import logging
import uuid
from decimal import Decimal
from typing import Optional

import firebase_admin
from firebase_admin import auth as firebase_auth, credentials
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_async_session
from app.models.user import User

logger = logging.getLogger(__name__)

_firebase_app: Optional[firebase_admin.App] = None


def _init_firebase() -> firebase_admin.App:
    global _firebase_app
    if _firebase_app is not None:
        return _firebase_app

    settings = get_settings()
    cred = None
    if settings.firebase_credentials_json:
        raw = settings.firebase_credentials_json
        try:
            parsed = json.loads(raw)
            cred = credentials.Certificate(parsed)
        except (json.JSONDecodeError, ValueError):
            cred = credentials.Certificate(raw)

    options = {}
    if settings.firebase_project_id:
        options["projectId"] = settings.firebase_project_id

    if cred:
        _firebase_app = firebase_admin.initialize_app(cred, options)
    else:
        _firebase_app = firebase_admin.initialize_app(options=options)
    return _firebase_app


def verify_firebase_token(id_token: str) -> dict:
    """Verify a Firebase ID token and return the decoded claims."""
    _init_firebase()
    try:
        return firebase_auth.verify_id_token(id_token)
    except Exception as exc:
        raise HTTPException(status_code=401, detail=f"Invalid Firebase token: {exc}")


async def get_firebase_user(
    request: Request,
    session: AsyncSession = Depends(get_async_session),
) -> User:
    """FastAPI dependency: verify Firebase ID token, return User row.

    Same signature as fastapi-users' current_active_user.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")

    id_token = auth_header[7:]
    claims = verify_firebase_token(id_token)

    firebase_uid = claims["uid"]
    email = claims.get("email", "")

    # Look up by firebase_uid first, then by email
    user = await session.scalar(
        select(User).where(User.firebase_uid == firebase_uid)
    )
    if user is None and email:
        user = await session.scalar(
            select(User).where(User.email == email)
        )
        if user is not None:
            user.firebase_uid = firebase_uid
            session.add(user)
            await session.commit()
            await session.refresh(user)

    if user is None:
        # Auto-register on first Firebase login
        user = User(
            id=uuid.uuid4(),
            email=email,
            hashed_password="__firebase__",
            is_active=True,
            is_verified=True,
            firebase_uid=firebase_uid,
            preferences={
                "language": "en",
                "date_format": "MM/DD/YYYY",
                "currency_display": "USD",
            },
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)

        # Create personal workspace + defaults (mirrors UserManager.on_after_register)
        from app.models.account import Account
        from app.services.category_service import create_default_categories
        from app.services.rule_service import create_default_rules
        from app.services.workspace_service import create_personal_workspace_for_user

        workspace = await create_personal_workspace_for_user(session, user)
        wallet = Account(
            user_id=user.id,
            workspace_id=workspace.id,
            name="Wallet",
            type="checking",
            balance=Decimal("0.00"),
            currency=user.primary_currency,
        )
        session.add(wallet)
        await session.commit()
        await create_default_categories(session, user.id, "en", workspace_id=workspace.id)
        await create_default_rules(session, user.id, "en", workspace_id=workspace.id)
        logger.info("Auto-created user %s from Firebase login", user.id)

    if not user.is_active:
        raise HTTPException(status_code=401, detail="User is inactive")

    return user


async def get_firebase_superuser(
    user: User = Depends(get_firebase_user),
) -> User:
    """FastAPI dependency: verify Firebase user is an active superuser."""
    if not user.is_superuser:
        raise HTTPException(status_code=403, detail="Not a superuser")
    return user

