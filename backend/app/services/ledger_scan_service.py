import base64
import json
import logging
import re
import uuid
from decimal import Decimal, InvalidOperation
from datetime import date
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.config import get_agent_settings
from app.agents.providers.base import ChatMessage
from app.agents.providers.gemini import GeminiProvider
from app.models.account import Account
from app.models.category import Category
from app.models.payee import Payee
from app.schemas.ledger_scan import (
    LedgerBulkSaveItem,
    LedgerBulkSaveResponse,
    LedgerScanItem,
    LedgerScanPreview,
)
from app.schemas.transaction import TransactionCreate, TransferCreate
from app.services import payee_service, transaction_service

logger = logging.getLogger(__name__)


def _clean_json_text(text: str) -> str:
    """Strip markdown code fence if present."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text.strip()


async def scan_ledger_image(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    image_bytes: bytes,
    content_type: str = "image/jpeg",
) -> LedgerScanPreview:
    """Analyze a handwritten ledger (Roznamcha) image using Gemini Vision."""
    # 1. Fetch workspace context: accounts, categories, payees
    accounts_res = await session.execute(
        select(Account.id, Account.name, Account.type, Account.currency)
        .where(Account.workspace_id == workspace_id)
        .order_by(Account.name)
    )
    accounts = accounts_res.fetchall()
    account_lookup = {str(a.id): a.name for a in accounts}
    accounts_summary = [
        {"id": str(a.id), "name": a.name, "type": a.type, "currency": a.currency}
        for a in accounts
    ]

    categories_res = await session.execute(
        select(Category.id, Category.name)
        .where(Category.workspace_id == workspace_id)
        .order_by(Category.name)
    )
    categories = categories_res.fetchall()
    category_lookup = {str(c.id): c.name for c in categories}
    categories_summary = [{"id": str(c.id), "name": c.name} for c in categories]

    payees_res = await session.execute(
        select(Payee.id, Payee.name)
        .where(Payee.workspace_id == workspace_id)
        .order_by(Payee.name)
        .limit(100)
    )
    payees = payees_res.fetchall()
    payee_lookup = {str(p.id): p.name for p in payees}
    payees_summary = [{"id": str(p.id), "name": p.name} for p in payees]

    # 2. Build Vision Prompt
    b64_image = base64.b64encode(image_bytes).decode("ascii")
    image_data_uri = f"data:{content_type};base64,{b64_image}"

    system_prompt = f"""You are an expert accounting vision assistant specializing in parsing handwritten Indian daily cash books (Roznamcha / Bahi-Khata).
You are provided with an image of a handwritten daily ledger page. Your task is to extract all discrete financial transactions while checking arithmetic reconciliation.

### WORKSPACE CONTEXT:
ACCOUNTS AVAILABLE IN WORKSPACE:
{json.dumps(accounts_summary, indent=2)}

CATEGORIES AVAILABLE IN WORKSPACE:
{json.dumps(categories_summary, indent=2)}

KNOWN PAYEES IN WORKSPACE:
{json.dumps(payees_summary, indent=2)}

### ROZNAMCHA / DAY BOOK PARSING RULES:
1. DATE:
   - Identify the date header (e.g. "27/7/26" -> 2026-07-27, "3/8/26" -> 2026-08-03).
2. BALANCING, B/F & C/F:
   - "B/F [amounts]" represents Brought Forward opening cash. Extract the total sum as `opening_balance_bf` and the exact addition breakdown (e.g. "19800 + 10935" or "19800 + 2500 + 5550") as `opening_balance_bf_breakdown`. DO NOT create a transaction for B/F.
   - "C/F [amounts]" represents Carried Forward closing cash. Extract the total sum as `closing_balance_cf` and the exact addition breakdown (e.g. "19800 + 11235" or "219800 + 2500 + 9770") as `closing_balance_cf_breakdown`. DO NOT create a transaction for C/F.
   - Extract "Left Total" and "Right Total" written on the page (e.g. 39131 or 278538).
3. LEFT COLUMN (RECEIPTS / INFLOWS / AAMAD) -> side "left":
   - Cheques received, bank withdrawals (e.g. "SBIRIE self ch. No."), sales, and inbound transfers.
   - For sales with cash + HUF splits: e.g. "Sale cash: 300 + HUF - 4698":
     * Item 1: amount 300, type "credit", side "left", account "Cash - Wallet", category "Sales", notes: "Mode: Cash", raw_text: "Sale cash: 300", breakdown_text: "Cash: 300"
     * Item 2: amount 4698, type "credit", side "left", account "SBI - Ganesh Kejariwal HUF", category "Sales", notes: "Mode: Bank Transfer", raw_text: "HUF - 4698", breakdown_text: "HUF: 4698"
   - For cheques: e.g. "3398 ) DRANK DAV PNB ch. 739162" -> amount 3398, type "credit", side "left", payee "DRANK", description: "DAV PNB ch. 739162".
4. RIGHT COLUMN (PAYMENTS / EXPENSES / OUTFLOWS / TRANSFERS) -> side "right":
   - Regular expenses: e.g. "1110 ) House Exp (राशन: 510 + 600)" -> type "debit", side "right", amount 1110, description: "House Exp", category: "House", breakdown_text: "राशन: 510 + 600".
   - Transfers to bank / HUF balancing contra:
     * e.g. "3398 ) SBIRIE tr. frm DRANK" -> transfer from DRANK cheque to SBIRIE bank account.
     * e.g. "4698 ) SKHUF tr frm sale" -> transfer of the HUF sale component to HUF account.
5. BANK TRANSFERS & DIRECT BANK EXPENSES (CRITICAL RULE):
   - When an entry records a direct bank payment for an expense (e.g. "17340 ) Ayush IDFC Bank tr to Lenskart" on the left paired with "House Exp: Ayush Lenskart 17340" on the right):
     * DO NOT create duplicate or multiple transactions! This is ONE single expense transaction:
       type: "debit", amount: 17340, account: "IDFC - Ayush Kejariwal", payee_name: "Lenskart", category: "House", notes: "Paid via Ayush IDFC Bank to Lenskart", is_transfer: false.
     * Same for "319 ) Ayush Federal tr to Recharge":
       type: "debit", amount: 319, account: "Federal - Ayush Kejariwal", payee_name: "Recharge", category: "House", notes: "Paid via Ayush Federal for Recharge", is_transfer: false.
   - For inter-account bank transfers (e.g. "44900 ) DAV SOCP Brajrajnagar tr to SBIRIE" or "24750 ) DAV Brajrajnagar tr to SBIRIE"):
     * Represent as a SINGLE transfer transaction:
       type: "debit", is_transfer: true, amount: 44900, description: "Transfer to SBIRIE", transfer_target_account_id: [ID of SBI - CC - GPW Offset].
   - For cash withdrawals (e.g. "200000 ) SBIRIE self ch. No."):
     * This is a transfer from bank to cash:
       type: "credit", is_transfer: true, amount: 200000, description: "Self Cheque Cash Withdrawal", account: "Cash - Wallet", transfer_target_account_id: [ID of SBI - CC - GPW Offset].
6. ACCOUNT ABBREVIATION GUIDE:
   - "Cash" / "Wallet" -> Cash - Wallet
   - "SK HUF" / "HUF" -> SBI - Ganesh Kejariwal HUF
   - "SBI RIE" / "SBIRIE" / "GPW" -> SBI - CC - GPW Offset
   - "MK SBI" / "MKSBI" / "sarv a/c" -> SBI - Madhu Kejriwal
   - "Ayush Federal" / "Federal" -> Federal - Ayush Kejariwal
   - "Ayush IDFC" / "IDFC" -> IDFC - Ayush Kejariwal
   - "BOB MK" -> BOB - Madhu Kejriwal

### OUTPUT FORMAT:
You MUST return ONLY valid JSON matching this schema:
{{
  "page_date": "YYYY-MM-DD",
  "opening_balance_bf": 30735,
  "opening_balance_bf_breakdown": "19800 + 10935",
  "closing_balance_cf": 31035,
  "closing_balance_cf_breakdown": "19800 + 11235",
  "left_total": 39131,
  "right_total": 39131,
  "transactions": [
    {{
      "date": "YYYY-MM-DD",
      "type": "credit" or "debit",
      "side": "left" or "right",
      "amount": 3398.00,
      "description": "DRANK DAV PNB ch. 739162",
      "account_id": "uuid-or-null",
      "category_id": "uuid-or-null",
      "payee_id": "uuid-or-null",
      "payee_name": "DRANK",
      "notes": "Mode: Cheque",
      "raw_text": "3398 ) DRANK DAV PNB ch. 739162",
      "breakdown_text": null,
      "is_transfer": false,
      "transfer_target_account_id": null
    }}
  ],
  "warnings": []
}}
Do NOT include markdown formatting or extra text outside the JSON object."""

    settings = get_agent_settings()
    provider = GeminiProvider(api_key=settings.gemini_api_key)

    messages = [
        ChatMessage(
            role="user",
            content=system_prompt,
            images=[image_data_uri],
        )
    ]

    raw_response = ""
    async for chunk in provider.chat_stream(messages, model="gemini-2.5-flash", temperature=0.1):
        if chunk.text:
            raw_response += chunk.text

    cleaned_json = _clean_json_text(raw_response)
    try:
        parsed = json.loads(cleaned_json)
    except json.JSONDecodeError as exc:
        logger.error("Failed to parse Gemini response as JSON: %s\nRaw: %s", exc, raw_response)
        # Attempt fallback regex extraction
        match = re.search(r"\{.*\}", cleaned_json, re.DOTALL)
        if match:
            parsed = json.loads(match.group(0))
        else:
            raise ValueError(f"Gemini did not return valid JSON: {raw_response[:200]}") from exc

    # Parse and validate fields
    try:
        page_date = date.fromisoformat(parsed.get("page_date", str(date.today())))
    except Exception:
        page_date = date.today()

    opening_bf = Decimal(str(parsed.get("opening_balance_bf", 0))) if parsed.get("opening_balance_bf") is not None else None
    opening_bf_breakdown = str(parsed.get("opening_balance_bf_breakdown", "")) if parsed.get("opening_balance_bf_breakdown") else None
    closing_cf = Decimal(str(parsed.get("closing_balance_cf", 0))) if parsed.get("closing_balance_cf") is not None else None
    closing_cf_breakdown = str(parsed.get("closing_balance_cf_breakdown", "")) if parsed.get("closing_balance_cf_breakdown") else None
    left_tot = Decimal(str(parsed.get("left_total", 0))) if parsed.get("left_total") is not None else None
    right_tot = Decimal(str(parsed.get("right_total", 0))) if parsed.get("right_total") is not None else None

    # Calculate reconciliation balance
    is_balanced = True
    diff = Decimal("0.00")
    if left_tot is not None and right_tot is not None:
        diff = abs(left_tot - right_tot)
        is_balanced = (diff == 0)

    parsed_txs = []
    for i, t in enumerate(parsed.get("transactions", [])):
        amt = Decimal(str(t.get("amount", 0)))
        t_type = "debit" if t.get("type", "debit").lower() == "debit" else "credit"
        desc = t.get("description") or ("Sales" if t_type == "credit" else "Expense")
        
        acc_id = None
        if t.get("account_id") and str(t.get("account_id")) in account_lookup:
            acc_id = uuid.UUID(str(t.get("account_id")))
        
        cat_id = None
        if t.get("category_id") and str(t.get("category_id")) in category_lookup:
            cat_id = uuid.UUID(str(t.get("category_id")))

        payee_id = None
        if t.get("payee_id") and str(t.get("payee_id")) in payee_lookup:
            payee_id = uuid.UUID(str(t.get("payee_id")))

        tr_target_id = None
        if t.get("transfer_target_account_id") and str(t.get("transfer_target_account_id")) in account_lookup:
            tr_target_id = uuid.UUID(str(t.get("transfer_target_account_id")))

        # Resolve names
        acc_name = account_lookup.get(str(acc_id)) if acc_id else None
        cat_name = category_lookup.get(str(cat_id)) if cat_id else None
        p_name = payee_lookup.get(str(payee_id)) if payee_id else t.get("payee_name")
        tr_target_name = account_lookup.get(str(tr_target_id)) if tr_target_id else None

        side = t.get("side")
        if not side:
            side = "left" if t_type == "credit" else "right"

        parsed_txs.append(
            LedgerScanItem(
                id=f"idx-{i}",
                date=page_date,
                type=t_type,
                amount=amt,
                description=desc,
                account_id=acc_id,
                account_name=acc_name,
                category_id=cat_id,
                category_name=cat_name,
                payee_id=payee_id,
                payee_name=p_name,
                notes=t.get("notes"),
                raw_text=t.get("raw_text"),
                confidence=float(t.get("confidence", 0.95)),
                is_transfer=bool(t.get("is_transfer", False)),
                transfer_target_account_id=tr_target_id,
                transfer_target_account_name=tr_target_name,
                side=side,
                breakdown_text=t.get("breakdown_text"),
            )
        )

    return LedgerScanPreview(
        page_date=page_date,
        opening_balance_bf=opening_bf,
        opening_balance_bf_breakdown=opening_bf_breakdown,
        closing_balance_cf=closing_cf,
        closing_balance_cf_breakdown=closing_cf_breakdown,
        left_total=left_tot,
        right_total=right_tot,
        is_balanced=is_balanced,
        balance_difference=diff,
        transactions=parsed_txs,
        warnings=parsed.get("warnings", []),
    )


async def bulk_save_ledger_transactions(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    items: list[LedgerBulkSaveItem],
) -> LedgerBulkSaveResponse:
    """Save approved ledger transactions directly into the workspace."""
    created_ids: list[uuid.UUID] = []

    # Cache transfers category if needed
    transfers_cat_res = await session.execute(
        select(Category.id)
        .where(Category.workspace_id == workspace_id, Category.name == "Transfers")
        .limit(1)
    )
    transfers_cat_id = transfers_cat_res.scalar_one_or_none()

    for item in items:
        # Check if it's a transfer between two accounts
        if item.is_transfer and item.transfer_target_account_id:
            from_account_id = item.account_id if item.type == "debit" else item.transfer_target_account_id
            to_account_id = item.transfer_target_account_id if item.type == "debit" else item.account_id
            transfer_data = TransferCreate(
                from_account_id=from_account_id,
                to_account_id=to_account_id,
                amount=item.amount,
                date=item.date,
                description=item.description or "Transfer",
                notes=item.notes,
            )
            debit_tx, credit_tx = await transaction_service.create_transfer(
                session, workspace_id, user_id, transfer_data
            )
            created_ids.extend([debit_tx.id, credit_tx.id])

        else:
            # Regular transaction
            # Resolve or create payee if payee_name given without payee_id
            payee_id = item.payee_id
            if not payee_id and item.payee_name and item.payee_name.strip():
                p = await payee_service.get_or_create_payee(
                    session, workspace_id, item.payee_name.strip()
                )
                if p:
                    payee_id = p.id

            data = TransactionCreate(
                account_id=item.account_id,
                category_id=item.category_id,
                payee_id=payee_id,
                amount=item.amount,
                date=item.date,
                type=item.type,
                description=item.description,
                notes=item.notes,
            )
            tx = await transaction_service.create_transaction(session, workspace_id, user_id, data)
            created_ids.append(tx.id)

    return LedgerBulkSaveResponse(created_count=len(created_ids), created_ids=created_ids)
