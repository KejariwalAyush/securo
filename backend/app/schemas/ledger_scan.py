import uuid
from datetime import date
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class LedgerScanItem(BaseModel):
    id: Optional[str] = None
    date: date
    type: Literal["debit", "credit"]
    amount: Decimal
    description: str
    category_id: Optional[uuid.UUID] = None
    category_name: Optional[str] = None
    account_id: Optional[uuid.UUID] = None
    account_name: Optional[str] = None
    payee_id: Optional[uuid.UUID] = None
    payee_name: Optional[str] = None
    notes: Optional[str] = None
    raw_text: Optional[str] = None
    confidence: float = 1.0
    is_transfer: bool = False
    transfer_target_account_id: Optional[uuid.UUID] = None
    transfer_target_account_name: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class LedgerScanPreview(BaseModel):
    page_date: date
    opening_balance_bf: Optional[Decimal] = None
    closing_balance_cf: Optional[Decimal] = None
    left_total: Optional[Decimal] = None
    right_total: Optional[Decimal] = None
    is_balanced: bool = True
    balance_difference: Optional[Decimal] = Decimal("0.00")
    transactions: list[LedgerScanItem] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class LedgerBulkSaveItem(BaseModel):
    date: date
    type: Literal["debit", "credit"]
    amount: Decimal
    description: str
    account_id: uuid.UUID
    category_id: Optional[uuid.UUID] = None
    payee_id: Optional[uuid.UUID] = None
    payee_name: Optional[str] = None
    notes: Optional[str] = None
    is_transfer: bool = False
    transfer_target_account_id: Optional[uuid.UUID] = None


class LedgerBulkSaveRequest(BaseModel):
    transactions: list[LedgerBulkSaveItem]


class LedgerBulkSaveResponse(BaseModel):
    created_count: int
    created_ids: list[uuid.UUID]
