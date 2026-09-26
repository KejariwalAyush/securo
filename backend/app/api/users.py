import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi_users import exceptions
from fastapi_users.router.common import ErrorCode
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import (
    UserManager,
    current_active_user,
    current_superuser,
    get_user_manager,
)
from app.core.database import get_async_session
from app.models.user import User
from app.schemas.user import UserRead, UserUpdate

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("/me", response_model=UserRead, name="users:current_user")
async def me(
    user: User = Depends(current_active_user),
):
    return UserRead.model_validate(user)


@router.patch("/me", response_model=UserRead, name="users:patch_current_user")
async def update_me(
    request: Request,
    user_update: UserUpdate,
    user: User = Depends(current_active_user),
    user_manager: UserManager = Depends(get_user_manager),
):
    try:
        user = await user_manager.update(
            user_update, user, safe=True, request=request
        )
        return UserRead.model_validate(user)
    except exceptions.InvalidPasswordException as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": ErrorCode.UPDATE_USER_INVALID_PASSWORD,
                "reason": e.reason,
            },
        )
    except exceptions.UserAlreadyExists:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=ErrorCode.UPDATE_USER_EMAIL_ALREADY_EXISTS,
        )


@router.get("/{id}", response_model=UserRead, name="users:user")
async def get_user(
    id: uuid.UUID,
    _superuser: User = Depends(current_superuser),
    session: AsyncSession = Depends(get_async_session),
):
    user = await session.get(User, id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return UserRead.model_validate(user)


@router.patch("/{id}", response_model=UserRead, name="users:patch_user")
async def update_user(
    id: uuid.UUID,
    user_update: UserUpdate,
    request: Request,
    _superuser: User = Depends(current_superuser),
    user_manager: UserManager = Depends(get_user_manager),
    session: AsyncSession = Depends(get_async_session),
):
    user = await session.get(User, id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    try:
        user = await user_manager.update(
            user_update, user, safe=False, request=request
        )
        return UserRead.model_validate(user)
    except exceptions.InvalidPasswordException as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": ErrorCode.UPDATE_USER_INVALID_PASSWORD,
                "reason": e.reason,
            },
        )
    except exceptions.UserAlreadyExists:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=ErrorCode.UPDATE_USER_EMAIL_ALREADY_EXISTS,
        )


@router.delete("/{id}", status_code=status.HTTP_204_NO_CONTENT, name="users:delete_user")
async def delete_user(
    id: uuid.UUID,
    request: Request,
    _superuser: User = Depends(current_superuser),
    user_manager: UserManager = Depends(get_user_manager),
    session: AsyncSession = Depends(get_async_session),
):
    user = await session.get(User, id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    await user_manager.delete(user, request=request)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
