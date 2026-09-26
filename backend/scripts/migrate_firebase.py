"""Intelligent Firebase to Securo Data Migration Script.

Migrates accounts, categories, payees, and transactions from Firebase Firestore
(project studio-3131737339-ef9ce) into Securo's PostgreSQL database for a
specified workspace.

Features:
- Idempotent: sets transaction.external_id = 'firebase_<doc_id>' so re-running skips existing
- Normalizes accounts & creates missing accounts (e.g. ICICI CC)
- Creates category hierarchy (Factory, Home, Insurance, Savings, Vehicle) matching Firebase
- Imports all 119 payees with phone numbers and notes
- Reconciles transfer pairs using deterministic UUIDs
- Updates account balances to match imported transactions
- Dry-run mode for safe verification before committing

Usage inside container:
    python -m scripts.migrate_firebase --dry-run
    python -m scripts.migrate_firebase
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import date, datetime, timezone
from decimal import Decimal
import logging
import os
import sys
import uuid
from typing import Any, Optional

import firebase_admin
from firebase_admin import credentials, firestore
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session_maker
from app.models.account import Account
from app.models.category import Category
from app.models.category_group import CategoryGroup
from app.models.payee import Payee
from app.models.transaction import Transaction
from app.models.user import User
from app.models.workspace import Workspace

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("migrate_firebase")

# Default Target Configuration
TARGET_WORKSPACE_ID = uuid.UUID("7210a213-0f92-4ab7-a3fa-2775da934572")  # "HOME"
DEFAULT_USER_EMAIL = "ayushkejariwal290@gmail.com"
FIREBASE_CREDS_PATH = os.getenv("FIREBASE_CREDENTIALS_JSON", "/app/secrets/firebase-service-account.json")
FIREBASE_PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", "studio-3131737339-ef9ce")


def init_firestore() -> firestore.Client:
    """Initialize Firebase Admin and return Firestore client."""
    try:
        app = firebase_admin.get_app()
    except ValueError:
        if os.path.exists(FIREBASE_CREDS_PATH):
            cred = credentials.Certificate(FIREBASE_CREDS_PATH)
            app = firebase_admin.initialize_app(cred, {"projectId": FIREBASE_PROJECT_ID})
        else:
            app = firebase_admin.initialize_app(options={"projectId": FIREBASE_PROJECT_ID})
    return firestore.client()


def parse_date(raw: Any) -> date:
    """Convert Firestore timestamp / string / datetime into a Python date."""
    if raw is None:
        return date.today()
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    if isinstance(raw, str):
        # Handle ISO strings like '2026-04-26' or '2026-04-26T18:30:00.000Z'
        cleaned = raw[:10]
        try:
            return datetime.strptime(cleaned, "%Y-%m-%d").date()
        except Exception:
            pass
    return date.today()


async def get_or_create_target_context(session: AsyncSession, ws_id: uuid.UUID) -> tuple[Workspace, User]:
    """Retrieve the target workspace and default user."""
    workspace = await session.get(Workspace, ws_id)
    if not workspace:
        raise ValueError(f"Target workspace {ws_id} not found in database.")

    user = await session.scalar(select(User).where(User.email == DEFAULT_USER_EMAIL))
    if not user:
        user = await session.scalar(select(User).limit(1))
    if not user:
        raise ValueError("No user found in database to attribute migration to.")

    logger.info("Target workspace: '%s' (%s), Owner user: '%s' (%s)", workspace.name, workspace.id, user.email, user.id)
    return workspace, user


async def ensure_accounts_map(
    session: AsyncSession,
    workspace: Workspace,
    user: User,
    dry_run: bool = False,
) -> dict[str, uuid.UUID]:
    """Ensure all required accounts exist in Securo and return mapping from Firebase ID to Account UUID."""
    accounts = (await session.scalars(select(Account).where(Account.workspace_id == workspace.id))).all()
    acc_by_name = {a.name.strip().lower(): a for a in accounts}

    # Check if ICICI CC exists; if not, create it
    icici_key = "icici - cc - ayush kejariwal"
    icici_acc = acc_by_name.get(icici_key)
    if not icici_acc:
        logger.info("Creating missing account: 'ICICI - CC - Ayush Kejariwal' (Credit Card)")
        if not dry_run:
            icici_acc = Account(
                user_id=user.id,
                workspace_id=workspace.id,
                name="ICICI - CC - Ayush Kejariwal",
                type="credit_card",
                currency="INR",
                balance=Decimal("0.00"),
            )
            session.add(icici_acc)
            await session.flush()
            accounts.append(icici_acc)
            acc_by_name[icici_key] = icici_acc

    # Direct mapping table from Firebase ID / aliases to Securo Account Name
    firebase_to_securo_name: dict[str, str] = {
        "acc_bank_cash": "Cash - Wallet",
        "acc_bank_physical_cash": "Cash - Wallet",
        "acc_bank_gpw_cc": "SBI - CC - GPW Offset",
        "acc_bank_sbi_cc_gpw": "SBI - CC - GPW Offset",
        "acc_bank_gk_sbi": "SBI - Ganesh Kejariwal",
        "acc_bank_sbi_gk_personal": "SBI - Ganesh Kejariwal",
        "acc_bank_huf_sbi": "SBI - Ganesh Kejariwal HUF",
        "acc_bank_sbi_gk_huf": "SBI - Ganesh Kejariwal HUF",
        "acc_bank_ak_fed": "Federal - Ayush Kejariwal",
        "acc_bank_federal_ak": "Federal - Ayush Kejariwal",
        "acc_bank_ak_cc_icici": "ICICI - CC - Ayush Kejariwal",
        "acc_bank_ak_idfc": "IDFC - Ayush Kejariwal",
        "acc_bank_idfc_ak": "IDFC - Ayush Kejariwal",
        "acc_bank_mk_sbi": "SBI - Madhu Kejriwal",
        "acc_bank_sbi_mk_personal": "SBI - Madhu Kejriwal",
        "acc_bank_tk_sbi": "SBI - Tanush Kejariwal",
        "acc_bank_sbi_tk_personal": "SBI - Tanush Kejariwal",
        "acc_bank_ak_sbi": "SBI - Ayush Kejariwal",
        "acc_bank_sbi_ak_personal": "SBI - Ayush Kejariwal",
        "acc_bank_mk_bob": "BOB - Madhu Kejriwal",
        "acc_bank_gk_ppf": "SBI - PPF - Ganesh Kejariwal",
        "acc_bank_mk_ppf": "SBI - PPF - Madhu Kejriwal",
        "acc_bank_gk_hdfc": "HDFC - Ganesh Kejariwal Jnt",
        "acc_bank_union_gk_personal": "Union - Ganesh Kejariwal",
        "acc_bank_les_salary_gk": "SBI - Ganesh Kejariwal",
        "acc_bank_gk_corp": "HDFC - GPW Offset",
        # Test accounts map to Cash - Wallet
        "acc_bank_acc_01": "Cash - Wallet",
        "acc_bank_acc_03": "Cash - Wallet",
        "acc_bank_acc_05": "Cash - Wallet",
        "acc_bank_acc_07": "Cash - Wallet",
        "acc_bank_acc_efa1472b": "Cash - Wallet",
    }

    id_map: dict[str, uuid.UUID] = {}
    default_cash = acc_by_name.get("cash - wallet") or accounts[0]

    for fb_id, target_name in firebase_to_securo_name.items():
        matched = acc_by_name.get(target_name.strip().lower())
        if matched:
            id_map[fb_id] = matched.id
        else:
            # Fuzzy match
            for name, acc in acc_by_name.items():
                if target_name.lower() in name or name in target_name.lower():
                    id_map[fb_id] = acc.id
                    break
            if fb_id not in id_map:
                id_map[fb_id] = default_cash.id

    logger.info("Mapped %d Firebase account IDs to Securo accounts.", len(id_map))
    return id_map


async def ensure_categories_map(
    session: AsyncSession,
    workspace: Workspace,
    user: User,
    db_fs: firestore.Client,
    dry_run: bool = False,
) -> dict[str, uuid.UUID]:
    """Import Firebase category hierarchy and return map from Firebase cat ID to Category UUID."""
    # Existing groups and categories
    existing_groups = (await session.scalars(select(CategoryGroup).where(CategoryGroup.workspace_id == workspace.id))).all()
    group_by_name = {g.name.strip().lower(): g for g in existing_groups}

    existing_cats = (await session.scalars(select(Category).where(Category.workspace_id == workspace.id))).all()
    cat_by_name = {c.name.strip().lower(): c for c in existing_cats}

    cat_map: dict[str, uuid.UUID] = {}

    # Category Group style colors
    group_colors = {
        "factory": "#F59E0B",  # Amber
        "home": "#3B82F6",     # Blue
        "insurance": "#10B981",# Emerald
        "savings": "#8B5CF6",  # Violet
        "vehicle": "#EF4444",  # Red
    }

    fb_cats_docs = list(db_fs.collection("v2_categories").stream())
    logger.info("Found %d categories in Firebase Firestore v2_categories.", len(fb_cats_docs))

    for doc in fb_cats_docs:
        d = doc.to_dict()
        fb_id = doc.id
        cat_name = (d.get("name") or "").strip()
        group_name = (d.get("group") or "Other").strip()
        is_income = (fb_id == "cat_factory_sales" or d.get("type") == "income")

        if not cat_name:
            continue

        # Ensure CategoryGroup exists
        grp_key = group_name.lower()
        grp = group_by_name.get(grp_key)
        if not grp and not dry_run:
            grp = CategoryGroup(
                user_id=user.id,
                workspace_id=workspace.id,
                name=group_name,
                color=group_colors.get(grp_key, "#6B7280"),
                icon="folder",
            )
            session.add(grp)
            await session.flush()
            group_by_name[grp_key] = grp
            logger.info("Created CategoryGroup: '%s'", group_name)

        # Ensure Category exists
        cat_key = f"{group_name.lower()}::{cat_name.lower()}"
        cat = cat_by_name.get(cat_key) or cat_by_name.get(cat_name.lower())
        if not cat and not dry_run:
            cat = Category(
                user_id=user.id,
                workspace_id=workspace.id,
                group_id=grp.id if grp else None,
                name=cat_name,
                color=grp.color if grp else "#6B7280",
                icon="tag",
            )
            session.add(cat)
            await session.flush()
            cat_by_name[cat_key] = cat
            cat_by_name[cat_name.lower()] = cat
            logger.info("Created Category: '%s' under group '%s'", cat_name, group_name)

        if cat:
            cat_map[fb_id] = cat.id
            cat_map[cat_name.lower()] = cat.id

    logger.info("Mapped %d Firebase category IDs/names to Securo categories.", len(cat_map))
    return cat_map


async def ensure_payees_map(
    session: AsyncSession,
    workspace: Workspace,
    user: User,
    db_fs: firestore.Client,
    dry_run: bool = False,
) -> dict[str, uuid.UUID]:
    """Import payees from Firebase v2_payees and parties into Securo."""
    existing_payees = (await session.scalars(select(Payee).where(Payee.workspace_id == workspace.id))).all()
    payee_by_name = {p.name.strip().lower(): p for p in existing_payees}

    payee_map: dict[str, uuid.UUID] = {}

    fb_payees = list(db_fs.collection("v2_payees").stream())
    fb_parties = list(db_fs.collection("parties").stream())
    combined = {doc.id: doc.to_dict() for doc in fb_payees}
    for doc in fb_parties:
        if doc.id not in combined:
            combined[doc.id] = doc.to_dict()

    logger.info("Found %d distinct payees/parties in Firebase.", len(combined))

    created_count = 0
    for doc_id, d in combined.items():
        name = (d.get("name") or "").strip()
        if not name:
            continue
        norm_name = name.lower()
        payee = payee_by_name.get(norm_name)

        if not payee and not dry_run:
            notes = d.get("notes") or d.get("note") or ""
            balance = d.get("balance")
            if balance:
                notes = f"Initial balance: {balance}. {notes}".strip()
            phone = str(d.get("phone") or "")[:50] or None

            payee = Payee(
                user_id=user.id,
                workspace_id=workspace.id,
                name=name,
                phone=phone,
                notes=notes or None,
                source="manual",
            )
            session.add(payee)
            await session.flush()
            payee_by_name[norm_name] = payee
            created_count += 1

        if payee:
            payee_map[doc_id] = payee.id
            payee_map[norm_name] = payee.id

    logger.info("Imported/ensured %d payees (created %d new).", len(payee_by_name), created_count)
    return payee_map


async def migrate_transactions(
    session: AsyncSession,
    workspace: Workspace,
    user: User,
    db_fs: firestore.Client,
    account_map: dict[str, uuid.UUID],
    cat_map: dict[str, uuid.UUID],
    payee_map: dict[str, uuid.UUID],
    dry_run: bool = False,
) -> int:
    """Migrate transactions from Firestore v2_transactions into Securo."""
    # Find already migrated transactions by external_id
    existing_externals = set(
        await session.scalars(
            select(Transaction.external_id).where(
                Transaction.workspace_id == workspace.id,
                Transaction.external_id.is_not(None),
            )
        )
    )

    docs = list(db_fs.collection("v2_transactions").stream())
    logger.info("Found %d transactions in Firebase v2_transactions. (%d already imported)", len(docs), len(existing_externals))

    imported_count = 0
    skipped_count = 0
    default_acc_id = account_map.get("acc_bank_cash")

    for doc in docs:
        ext_id = f"firebase_{doc.id}"
        if ext_id in existing_externals:
            skipped_count += 1
            continue

        d = doc.to_dict()
        raw_amount = d.get("amount") or 0
        dec_amount = Decimal(str(raw_amount))

        # In Securo: amount is positive Decimal, type is 'credit' or 'debit'
        if dec_amount < 0:
            tx_type = "debit"
            amount = abs(dec_amount)
        elif dec_amount > 0:
            tx_type = "credit"
            amount = dec_amount
        else:
            tx_type = "debit"
            amount = Decimal("0.00")

        # Resolve Account
        fb_acc_id = d.get("account_id") or d.get("bank_account")
        account_id = account_map.get(fb_acc_id, default_acc_id)
        if not account_id:
            logger.warning("Could not resolve account for transaction %s (acc: %s)", doc.id, fb_acc_id)
            continue

        # Resolve Category
        cat_id = None
        fb_cat_id = d.get("category_id")
        fb_cat_name = d.get("category_name") or d.get("category")
        if fb_cat_id and fb_cat_id in cat_map:
            cat_id = cat_map[fb_cat_id]
        elif fb_cat_name and fb_cat_name.lower() in cat_map:
            cat_id = cat_map[fb_cat_name.lower()]

        # Resolve Payee
        payee_id = None
        payee_name = d.get("payee_name") or d.get("party_name") or ""
        fb_payee_id = d.get("payee_id") or d.get("party_id")
        if fb_payee_id and fb_payee_id in payee_map:
            payee_id = payee_map[fb_payee_id]
        elif payee_name and payee_name.lower() in payee_map:
            payee_id = payee_map[payee_name.lower()]
        elif payee_name and not dry_run:
            # Create payee dynamically
            new_p = Payee(
                user_id=user.id,
                workspace_id=workspace.id,
                name=payee_name.strip(),
                source="manual",
            )
            session.add(new_p)
            await session.flush()
            payee_map[payee_name.lower()] = new_p.id
            payee_id = new_p.id

        # Resolve Description
        description = (d.get("description") or payee_name or fb_cat_name or "Transaction").strip()

        # Date
        tx_date = parse_date(d.get("date") or d.get("timestamp") or d.get("created_at"))

        # Transfer pairing
        transfer_pair_id = None
        pair_key = d.get("transfer_pair_id")
        is_transfer = bool(d.get("is_transfer")) or bool(pair_key)
        if pair_key:
            # Deterministic UUID for the pair so both legs link together
            transfer_pair_id = uuid.uuid5(uuid.NAMESPACE_DNS, str(pair_key))

        notes_parts = []
        if d.get("notes"):
            notes_parts.append(str(d["notes"]))
        if d.get("spent_by"):
            notes_parts.append(f"Spent by: {d['spent_by']}")
        if d.get("payment_mode"):
            notes_parts.append(f"Mode: {d['payment_mode']}")
        notes = " | ".join(notes_parts) if notes_parts else None

        if not dry_run:
            tx = Transaction(
                user_id=user.id,
                workspace_id=workspace.id,
                account_id=account_id,
                category_id=cat_id,
                payee_id=payee_id,
                external_id=ext_id,
                description=description[:500],
                amount=amount,
                currency="INR",
                date=tx_date,
                effective_date=tx_date,
                type=tx_type,
                source="manual",
                status="posted",
                notes=notes[:1000] if notes else None,
                transfer_pair_id=transfer_pair_id,
                raw_data={"firebase_id": doc.id, "firebase_data": {k: str(v) for k, v in d.items() if k not in ("date", "timestamp")}},
            )
            session.add(tx)

        imported_count += 1
        if imported_count % 200 == 0:
            logger.info("Processed %d transactions...", imported_count)
            if not dry_run:
                await session.flush()

    if not dry_run:
        await session.commit()

    logger.info("Transactions migration complete: %d imported, %d skipped.", imported_count, skipped_count)
    return imported_count


async def recalculate_account_balances(session: AsyncSession, workspace: Workspace, dry_run: bool = False) -> None:
    """Recalculate and update the balance column for all accounts in the workspace based on transactions."""
    accounts = (await session.scalars(select(Account).where(Account.workspace_id == workspace.id))).all()
    logger.info("Recalculating balances for %d accounts...", len(accounts))

    for acc in accounts:
        # Sum credits - debits
        credits = (
            await session.scalar(
                select(func.coalesce(func.sum(Transaction.amount), 0)).where(
                    Transaction.account_id == acc.id,
                    Transaction.type == "credit",
                    Transaction.is_ignored == False,
                )
            )
        ) or 0
        debits = (
            await session.scalar(
                select(func.coalesce(func.sum(Transaction.amount), 0)).where(
                    Transaction.account_id == acc.id,
                    Transaction.type == "debit",
                    Transaction.is_ignored == False,
                )
            )
        ) or 0

        # For credit card, balance is positive debt (debits - credits)
        if acc.type == "credit_card":
            calc_balance = Decimal(str(debits)) - Decimal(str(credits))
        else:
            calc_balance = Decimal(str(credits)) - Decimal(str(debits))

        logger.info("Account '%s': Calculated Balance = %s INR (Credits: %s, Debits: %s)", acc.name, calc_balance, credits, debits)
        if not dry_run:
            acc.balance = calc_balance

    if not dry_run:
        await session.commit()


async def run_migration(dry_run: bool = False) -> None:
    """Run full migration pipeline."""
    logger.info("=== STARTING FIREBASE MIGRATION (dry_run=%s) ===", dry_run)
    db_fs = init_firestore()

    async with async_session_maker() as session:
        workspace, user = await get_or_create_target_context(session, TARGET_WORKSPACE_ID)

        # 1. Accounts
        account_map = await ensure_accounts_map(session, workspace, user, dry_run=dry_run)

        # 2. Categories
        cat_map = await ensure_categories_map(session, workspace, user, db_fs, dry_run=dry_run)

        # 3. Payees
        payee_map = await ensure_payees_map(session, workspace, user, db_fs, dry_run=dry_run)

        # 4. Transactions
        count = await migrate_transactions(
            session, workspace, user, db_fs, account_map, cat_map, payee_map, dry_run=dry_run
        )

        # 5. Balances
        if not dry_run:
            await recalculate_account_balances(session, workspace, dry_run=dry_run)

    logger.info("=== FIREBASE MIGRATION FINISHED SUCCESSFULLY (%d transactions) ===", count)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Migrate Firebase data to Securo")
    parser.add_argument("--dry-run", action="store_true", help="Perform a dry run without modifying the database")
    args = parser.parse_args()

    asyncio.run(run_migration(dry_run=args.dry_run))
