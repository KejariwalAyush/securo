import logging
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.core.workspace_context import (
    WorkspaceContext,
    current_workspace,
    current_writable_workspace,
)
from app.schemas.ledger_scan import (
    LedgerBulkSaveRequest,
    LedgerBulkSaveResponse,
    LedgerScanPreview,
)
from app.services import ledger_scan_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/transactions/import", tags=["ledger-scan"])


@router.post("/scan-ledger", response_model=LedgerScanPreview)
async def scan_ledger(
    file: UploadFile = File(...),
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Scan a handwritten Roznamcha daily ledger page using Gemini Vision."""
    filename = file.filename or ""
    content = await file.read()
    content_type = file.content_type or "image/jpeg"

    if not content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded file is empty",
        )

    logger.info(
        "Scanning ledger image: filename=%s, size=%d bytes, content_type=%s, workspace=%s",
        filename, len(content), content_type, ctx.workspace.id,
    )

    try:
        preview = await ledger_scan_service.scan_ledger_image(
            session=session,
            workspace_id=ctx.workspace.id,
            image_bytes=content,
            content_type=content_type,
        )
        return preview
    except Exception as e:
        logger.error("Failed to scan ledger image: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to scan ledger image: {str(e)}",
        )


@router.post("/bulk-save", response_model=LedgerBulkSaveResponse)
async def bulk_save(
    data: LedgerBulkSaveRequest,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Save approved ledger transactions directly into the active workspace."""
    if not data.transactions:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No transactions provided to save",
        )

    logger.info(
        "Bulk saving %d ledger transactions for workspace=%s, user=%s",
        len(data.transactions), ctx.workspace.id, ctx.user_id,
    )

    try:
        res = await ledger_scan_service.bulk_save_ledger_transactions(
            session=session,
            workspace_id=ctx.workspace.id,
            user_id=ctx.user_id,
            items=data.transactions,
        )
        return res
    except Exception as e:
        logger.error("Failed to bulk save ledger transactions: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to save transactions: {str(e)}",
        )
