"""Firebase auth endpoint — exchanges a Firebase ID token for app context.

The frontend sends the Firebase ID token after Google/email sign-in.
This endpoint verifies it, ensures the User row exists, and returns
the user info (the frontend stores the Firebase token directly as its
Bearer token for subsequent API calls).
"""
from fastapi import APIRouter, Depends

from app.core.firebase_auth import get_firebase_user
from app.models.user import User
from app.schemas.user import UserRead

router = APIRouter()


@router.post("/api/auth/firebase/verify", tags=["auth"])
async def verify_firebase_login(
    user: User = Depends(get_firebase_user),
):
    """Verify Firebase token and return user profile.

    Called by the frontend after Firebase sign-in to confirm the
    backend recognizes the user (auto-creates if needed).
    """
    return UserRead.model_validate(user)
