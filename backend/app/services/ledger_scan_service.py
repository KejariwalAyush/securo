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

### ROZNAMCHA PARSING RULES:
1. DATE:
   - Identify the date header (e.g. "1/8/26 Sat." or "27/7/26" -> YYYY-MM-DD format). If multiple dates (e.g. Sat & Sun), pick the primary date (the Saturday date).
2. BALANCING & TOTALS:
   - "B/F [amounts]" represents Brought Forward opening cash. Extract the total as `opening_balance_bf`. DO NOT create a transaction for B/F.
   - "C/F [amounts]" represents Carried Forward closing cash. Extract the total as `closing_balance_cf`. DO NOT create a transaction for C/F.
   - Extract "Left Total" and "Right Total" written on the page if visible.
3. INFLOWS (LEFT COLUMN) -> CREDIT TRANSACTIONS:
   - Direct sales or payee receipts: e.g. "5000 Gopiram" -> type "credit", amount 5000, payee "Gopi" (or Gopiram), category "Sales", account "Cash - Wallet", notes: "Spent by: Factory | Mode: Cash".
   - Split sales: e.g. "Sale-Cash-1700 + HUF 1380" -> split into TWO separate transactions:
     * Item 1: amount 1700, type "credit", account "Cash - Wallet", category "Sales", notes: "Spent by: Factory | Mode: Cash"
     * Item 2: amount 1380, type "credit", account "SBI - Ganesh Kejariwal HUF", category "Sales", notes: "Spent by: Factory | Mode: Bank Transfer"
4. OUTFLOWS (RIGHT COLUMN) -> DEBIT TRANSACTIONS:
   - "SKHUF tr. fm sale" or "SBIRIE tr frm..." are internal balancing/contra references for receipts that went to bank rather than cash. DO NOT create duplicate debit expenses for these!
   - Factory payroll / wages: e.g. "14105 Factory Payroll" -> type "debit", amount 14105, category "Staff", description "Staff", account "Cash - Wallet", notes: "Spent by: Factory | Mode: Cash".
   - Factory expenses: e.g. "120 Factory Exp. MOD" -> type "debit", amount 120, category "Misc.", description "Misc.", account "Cash - Wallet", notes: "Spent by: Factory | Mode: Cash".
   - Baleno / Destini vehicle expenses: e.g. "1000 Baleno petrol" -> type "debit", amount 1000, category "Baleno", description "Baleno", account "Cash - Wallet", notes: "Spent by: Vehicle | Mode: Cash".
   - House expenses: e.g. "10000 House Exp. MK" -> type "debit", amount 10000, category "House", description "House", payee "MK", account "Cash - Wallet", notes: "Spent by: Home | Mode: Cash".
5. BANK TRANSFERS / CONTRA (BOTTOM ENTRIES):
   - Entries like "15000 SBI RIE tr to MKSBI sarv a/c" and "15000 MKSBI sarv a/c tr fm SBI RIE":
     * This is an inter-account bank transfer.
     * Represent as a transfer transaction: amount 15000, type "debit", account "SBI - CC - GPW Offset", category "Transfers", description: "Transfer to Home", notes: "Spent by: Home | Mode: Bank Transfer", is_transfer: true, transfer_target_account_id: [ID of SBI - Madhu Kejriwal].
6. ACCOUNT ABBREVIATION GUIDE:
   - "Cash" / "Wallet" -> Cash - Wallet
   - "SK HUF" / "HUF" -> SBI - Ganesh Kejariwal HUF
   - "SBI RIE" / "GPW" -> SBI - CC - GPW Offset
   - "MK SBI" / "MKSBI" / "sarv a/c" -> SBI - Madhu Kejriwal
   - "Ayush Federal" / "Federal" -> Federal - Ayush Kejariwal
   - "IDFC" -> IDFC - Ayush Kejariwal
   - "BOB MK" -> BOB - Madhu Kejriwal

### OUTPUT FORMAT:
You MUST return ONLY valid JSON matching this schema:
{{
  "page_date": "YYYY-MM-DD",
  "opening_balance_bf": 45375,
  "closing_balance_cf": 27850,
  "left_total": 54455,
  "right_total": 54455,
  "transactions": [
    {{
      "date": "YYYY-MM-DD",
      "type": "credit" or "debit",
      "amount": 5000.00,
      "description": "Sales",
      "account_id": "uuid-or-null",
      "category_id": "uuid-or-null",
      "payee_id": "uuid-or-null",
      "payee_name": "Gopi",
      "notes": "Spent by: Factory | Mode: Cash",
      "raw_text": "5000 Gopiram",
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
    closing_cf = Decimal(str(parsed.get("closing_balance_cf", 0))) if parsed.get("closing_balance_cf") is not None else None
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
            )
        )

    return LedgerScanPreview(
        page_date=page_date,
        opening_balance_bf=opening_bf,
        closing_balance_cf=closing_cf,
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
