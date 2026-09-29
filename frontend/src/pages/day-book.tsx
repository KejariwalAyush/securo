import { useState, useMemo, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  BookOpen,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Plus,
  RefreshCw,
  Sparkles,
  Check,
  AlertCircle,
  ScanLine,
  ArrowRightLeft,
  ArrowRight,
  ExternalLink,
} from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { TransactionDialog, type TransactionSavePayload } from '@/components/transaction-dialog'
import { CategorySelect } from '@/components/category-select'
import {
  accounts as accountsApi,
  categories as categoriesApi,
  categoryGroups as categoryGroupsApi,
  transactions as transactionsApi,
} from '@/lib/api'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { useAuth } from '@/contexts/auth-context'
import type { LedgerScanItem, LedgerScanPreview, Transaction } from '@/types'
import { cn } from '@/lib/utils'

// Helper to format any currency number strictly as ₹[Amount] without any trailing parenthesis
function formatRupee(amount: number | null | undefined): string {
  if (amount == null || isNaN(amount)) return '₹0'
  const rounded = Math.round(amount)
  return `₹${rounded.toLocaleString('en-IN')}`
}

// Pre-packaged samples matching the user's handwritten ledger pages
const SAMPLE_PAGE_27_07_2026: LedgerScanPreview = {
  page_date: '2026-07-27',
  opening_balance_bf: 30735,
  opening_balance_bf_breakdown: '19800 + 10935',
  closing_balance_cf: 31035,
  closing_balance_cf_breakdown: '19800 + 11235',
  left_total: 39131,
  right_total: 39131,
  is_balanced: true,
  balance_difference: 0,
  transactions: [
    {
      id: 'sample-1-1',
      date: '2026-07-27',
      type: 'credit',
      side: 'left',
      amount: 3398,
      description: 'DRANK DAV PNB ch. 739162',
      account_name: 'Cash - Wallet',
      payee_name: 'DRANK',
      raw_text: 'DRANK DAV PNB ch. 739162',
      notes: 'PNB Cheque 739162',
      is_transfer: false,
    },
    {
      id: 'sample-1-2',
      date: '2026-07-27',
      type: 'credit',
      side: 'left',
      amount: 300,
      description: 'Daily Sale (Cash)',
      account_name: 'Cash - Wallet',
      raw_text: 'Sale cash: 300',
      breakdown_text: 'Cash: 300',
      notes: 'Daily cash sale',
      is_transfer: false,
    },
    {
      id: 'sample-1-3',
      date: '2026-07-27',
      type: 'credit',
      side: 'left',
      amount: 4698,
      description: 'Daily Sale (HUF)',
      account_name: 'SBI - Ganesh Kejariwal HUF',
      raw_text: 'HUF - 4698',
      breakdown_text: 'HUF: 4698',
      notes: 'Sale deposited directly to HUF account',
      is_transfer: false,
    },
    {
      id: 'sample-1-4',
      date: '2026-07-27',
      type: 'debit',
      side: 'right',
      amount: 3398,
      description: 'Bank Deposit: DRANK cheque to SBIRIE',
      account_name: 'Cash - Wallet',
      transfer_target_account_name: 'SBI - CC - GPW Offset',
      raw_text: 'SBIRIE tr. frm DRANK',
      notes: 'Transfer from Cheque into SBIRIE',
      is_transfer: true,
    },
    {
      id: 'sample-1-5',
      date: '2026-07-27',
      type: 'debit',
      side: 'right',
      amount: 4698,
      description: 'HUF Allocation: Sale to SKHUF',
      account_name: 'Cash - Wallet',
      transfer_target_account_name: 'SBI - Ganesh Kejariwal HUF',
      raw_text: 'SKHUF tr frm sale',
      notes: 'Transfer of sale portion to SK HUF account',
      is_transfer: true,
    },
  ],
  warnings: [],
}

// 3rd August sample accurately reflecting single unified transactions and bank transfers
const SAMPLE_PAGE_03_08_2026: LedgerScanPreview = {
  page_date: '2026-08-03',
  opening_balance_bf: 27850,
  opening_balance_bf_breakdown: '19800 + 2500 + 5550',
  closing_balance_cf: 232070,
  closing_balance_cf_breakdown: '219800 + 2500 + 9770',
  left_total: 278538,
  right_total: 278538,
  is_balanced: true,
  balance_difference: 0,
  transactions: [
    {
      id: 'sample-2-1',
      date: '2026-08-03',
      type: 'credit',
      side: 'left',
      amount: 200000,
      description: 'Self Cheque Cash Withdrawal',
      account_name: 'Cash - Wallet',
      transfer_target_account_name: 'SBI - CC - GPW Offset',
      raw_text: 'SBIRIE self ch. No.',
      notes: 'Cash withdrawal from SBIRIE deposited into Cash drawer',
      is_transfer: true,
    },
    {
      id: 'sample-2-2',
      date: '2026-08-03',
      type: 'credit',
      side: 'left',
      amount: 5330,
      description: 'Daily Sale (Cash)',
      account_name: 'Cash - Wallet',
      raw_text: 'Sale - cash 5330',
      breakdown_text: 'Cash: 5330',
      notes: 'Daily cash sales',
      is_transfer: false,
    },
    {
      id: 'sample-2-3',
      date: '2026-08-03',
      type: 'credit',
      side: 'left',
      amount: 250,
      description: 'Daily Sale (HUF)',
      account_name: 'SBI - Ganesh Kejariwal HUF',
      raw_text: 'HUF 250',
      breakdown_text: 'HUF: 250',
      notes: 'Sale portion allocated to HUF',
      is_transfer: false,
    },
    {
      id: 'sample-2-4',
      date: '2026-08-03',
      type: 'debit',
      side: 'right',
      amount: 1110,
      description: 'House Exp (राशन)',
      account_name: 'Cash - Wallet',
      payee_name: 'राशन',
      raw_text: 'House Exp राशन 510+600',
      breakdown_text: 'राशन: 510 + 600',
      notes: 'Paid from cash drawer',
      is_transfer: false,
    },
    // Single unified expense for Lenskart paid directly from IDFC Bank
    {
      id: 'sample-2-5',
      date: '2026-08-03',
      type: 'debit',
      side: 'right',
      amount: 17340,
      description: 'Lenskart (House Exp)',
      account_name: 'IDFC - Ayush Kejariwal',
      payee_name: 'Lenskart',
      raw_text: 'Ayush IDFC Bank tr to Lenskart',
      breakdown_text: 'Paid via IDFC Bank → Lenskart',
      notes: 'Paid directly from Ayush IDFC Bank to Lenskart',
      is_transfer: false,
    },
    // Single unified expense for Recharge paid directly from Federal Bank
    {
      id: 'sample-2-6',
      date: '2026-08-03',
      type: 'debit',
      side: 'right',
      amount: 319,
      description: 'Mobile Recharge (House Exp)',
      account_name: 'Federal - Ayush Kejariwal',
      payee_name: 'Recharge',
      raw_text: 'Ayush Federal tr to Recharge',
      breakdown_text: 'Paid via Federal Bank → Recharge',
      notes: 'Paid directly from Ayush Federal Bank for mobile recharge',
      is_transfer: false,
    },
    // Single unified expense for Ayush राशन from Federal Bank
    {
      id: 'sample-2-7',
      date: '2026-08-03',
      type: 'debit',
      side: 'right',
      amount: 208,
      description: 'Ayush राशन',
      account_name: 'Federal - Ayush Kejariwal',
      payee_name: 'राशन',
      raw_text: 'Ayush Federal tr to राशन (150 + 58)',
      breakdown_text: '150 + 58',
      notes: 'Paid via Ayush Federal for grocery',
      is_transfer: false,
    },
    // Linked bank-to-bank transfer
    {
      id: 'sample-2-8',
      date: '2026-08-03',
      type: 'debit',
      side: 'right',
      amount: 44900,
      description: 'Transfer: DAV SOCP Brajrajnagar → SBIRIE',
      account_name: 'DAV SOCP Brajrajnagar',
      transfer_target_account_name: 'SBI - CC - GPW Offset',
      raw_text: 'DAV SOCP Brayrajnagar tr to SBIRIE',
      notes: 'Inter-account transfer to SBIRIE',
      is_transfer: true,
    },
    // Linked bank-to-bank transfer
    {
      id: 'sample-2-9',
      date: '2026-08-03',
      type: 'debit',
      side: 'right',
      amount: 24750,
      description: 'Transfer: DAV Brajrajnagar → SBIRIE',
      account_name: 'DAV Brajrajnagar',
      transfer_target_account_name: 'SBI - CC - GPW Offset',
      raw_text: 'DAV Brajrajnagar tr to SBIRIE',
      notes: 'Inter-account transfer to SBIRIE',
      is_transfer: true,
    },
  ],
  warnings: [],
}

interface QuickAddModalState {
  open: boolean
  item: LedgerScanItem | null
  accountId: string
  categoryId: string
  payeeName: string
  notes: string
  isTransfer: boolean
  targetAccountId: string
}

export default function DayBookPage() {
  const queryClient = useQueryClient()
  const { user: _user } = useAuth()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedDate, setSelectedDate] = useState<string>('2026-07-27')
  const [isScanning, setIsScanning] = useState(false)

  // Scanned / comparison preview state
  const [scanPreview, setScanPreview] = useState<LedgerScanPreview | null>(null)
  const [scanCompareModalOpen, setScanCompareModalOpen] = useState(false)

  // Transaction view/edit modal state on tap
  const [editingTx, setEditingTx] = useState<Transaction | null>(null)
  const [txDialogOpen, setTxDialogOpen] = useState(false)

  // Direct add single item modal state
  const [quickAddModal, setQuickAddModal] = useState<QuickAddModalState>({
    open: false,
    item: null,
    accountId: '',
    categoryId: '',
    payeeName: '',
    notes: '',
    isTransfer: false,
    targetAccountId: '',
  })

  // 1. Fetch Securo recorded transactions for the selected date from transaction history
  const { data: securoTransactionsData } = useQuery({
    queryKey: ['transactions', 'day-book', selectedDate],
    queryFn: () =>
      transactionsApi.list({
        from: selectedDate,
        to: selectedDate,
        limit: 150,
      }),
  })

  const dayTransactions: Transaction[] = useMemo(() => {
    return securoTransactionsData?.items ?? []
  }, [securoTransactionsData])

  // 2. Fetch Accounts & Categories
  const { data: accountsList = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => accountsApi.list(),
  })

  const { data: categoriesList = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => categoriesApi.list(),
  })

  const { data: categoryGroupsList = [] } = useQuery({
    queryKey: ['category-groups'],
    queryFn: () => categoryGroupsApi.list(),
  })

  // Account lookup helper
  const accountMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of accountsList) {
      map.set(a.id, a.name)
    }
    return map
  }, [accountsList])

  const defaultAccountId = useMemo(() => {
    const cashAcc = accountsList.find((a) =>
      a.name.toLowerCase().includes('cash') || a.name.toLowerCase().includes('wallet')
    )
    return cashAcc?.id || accountsList[0]?.id || ''
  }, [accountsList])

  // Date controls
  const handleDateChange = (newDate: string) => {
    setSelectedDate(newDate)
  }

  const shiftDate = (days: number) => {
    try {
      const d = new Date(selectedDate)
      d.setDate(d.getDate() + days)
      const formatted = d.toISOString().slice(0, 10)
      handleDateChange(formatted)
    } catch {
      // ignore
    }
  }

  // 3. Split real transactions into Day Book columns:
  // Left Column = Receipts / Credits / Inflows
  const dayReceipts = useMemo(() => {
    return dayTransactions.filter((tx) => tx.type === 'credit')
  }, [dayTransactions])

  // Right Column = Payments / Debits / Outflows
  const dayPayments = useMemo(() => {
    return dayTransactions.filter((tx) => tx.type === 'debit')
  }, [dayTransactions])

  const totalReceipts = useMemo(() => {
    return dayReceipts.reduce((sum, tx) => sum + Math.abs(Number(tx.amount)), 0)
  }, [dayReceipts])

  const totalPayments = useMemo(() => {
    return dayPayments.reduce((sum, tx) => sum + Math.abs(Number(tx.amount)), 0)
  }, [dayPayments])

  // Opening & Closing cash balances:
  const openingBF = useMemo(() => {
    if (scanPreview?.page_date === selectedDate && scanPreview.opening_balance_bf != null) {
      return Number(scanPreview.opening_balance_bf)
    }
    return 0
  }, [scanPreview, selectedDate])

  const openingBFBreakdown = useMemo(() => {
    if (scanPreview?.page_date === selectedDate && scanPreview.opening_balance_bf_breakdown) {
      return scanPreview.opening_balance_bf_breakdown
    }
    return null
  }, [scanPreview, selectedDate])

  const closingCF = useMemo(() => {
    if (scanPreview?.page_date === selectedDate && scanPreview.closing_balance_cf != null) {
      return Number(scanPreview.closing_balance_cf)
    }
    // Net flow calculation
    return openingBF + totalReceipts - totalPayments
  }, [scanPreview, selectedDate, openingBF, totalReceipts, totalPayments])

  const closingCFBreakdown = useMemo(() => {
    if (scanPreview?.page_date === selectedDate && scanPreview.closing_balance_cf_breakdown) {
      return scanPreview.closing_balance_cf_breakdown
    }
    return null
  }, [scanPreview, selectedDate])

  const leftTotal = useMemo(() => {
    return openingBF + totalReceipts
  }, [openingBF, totalReceipts])

  const rightTotal = useMemo(() => {
    return totalPayments + closingCF
  }, [totalPayments, closingCF])

  const isBalanced = useMemo(() => {
    return Math.abs(leftTotal - rightTotal) < 0.01
  }, [leftTotal, rightTotal])

  // 4. File Upload & Scan Handler
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsScanning(true)
    try {
      const res = await transactionsApi.scanLedger(file)
      setScanPreview(res)
      if (res.page_date) {
        setSelectedDate(res.page_date)
      }
      setScanCompareModalOpen(true)
      toast.success(`Handwritten ledger scanned for ${res.page_date}!`)
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || err?.message || 'Failed to scan handwritten ledger')
    } finally {
      setIsScanning(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  // Load sample into scan compare popup
  const loadSampleScan = (sample: LedgerScanPreview) => {
    setScanPreview(sample)
    setSelectedDate(sample.page_date)
    setScanCompareModalOpen(true)
  }

  // 5. Comparison Engine between Scanned Items & Day's Recorded Transactions
  const comparisonResults = useMemo(() => {
    if (!scanPreview) {
      return {
        matched: [] as Array<{ scanned: LedgerScanItem; recorded: Transaction }>,
        missingInSecuro: [] as LedgerScanItem[],
      }
    }

    const matched: Array<{ scanned: LedgerScanItem; recorded: Transaction }> = []
    const missing: LedgerScanItem[] = []
    const matchedRecordedIds = new Set<string>()

    for (const item of scanPreview.transactions) {
      const itemAmt = Number(item.amount)
      const candidate = dayTransactions.find((tx) => {
        if (matchedRecordedIds.has(tx.id)) return false
        const txAmt = Math.abs(Number(tx.amount))
        if (Math.abs(txAmt - itemAmt) > 0.5) return false
        if (item.type === 'credit' && tx.type !== 'credit') return false
        if (item.type === 'debit' && tx.type !== 'debit') return false
        return true
      })

      if (candidate) {
        matched.push({ scanned: item, recorded: candidate })
        matchedRecordedIds.add(candidate.id)
      } else {
        missing.push(item)
      }
    }

    return { matched, missingInSecuro: missing }
  }, [scanPreview, dayTransactions])

  // Single Direct Add Mutation
  const createTxMutation = useMutation({
    mutationFn: async (payload: {
      account_id: string
      amount: number
      date: string
      type: 'debit' | 'credit'
      description: string
      category_id?: string | null
      payee_name?: string | null
      notes?: string | null
      is_transfer?: boolean
      transfer_target_account_id?: string | null
    }) => {
      if (payload.is_transfer && payload.transfer_target_account_id) {
        return transactionsApi.createTransfer({
          from_account_id: payload.type === 'debit' ? payload.account_id : payload.transfer_target_account_id,
          to_account_id: payload.type === 'debit' ? payload.transfer_target_account_id : payload.account_id,
          amount: payload.amount,
          date: payload.date,
          description: payload.description || 'Transfer',
          notes: payload.notes || undefined,
        })
      } else {
        return transactionsApi.create({
          account_id: payload.account_id,
          amount: payload.amount,
          date: payload.date,
          type: payload.type,
          description: payload.description,
          category_id: payload.category_id || undefined,
          payee: payload.payee_name || undefined,
          notes: payload.notes || undefined,
        })
      }
    },
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      toast.success('Transaction saved directly to Day Book!')
      setQuickAddModal((prev) => ({ ...prev, open: false }))
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || err?.message || 'Failed to save transaction')
    },
  })

  // Open Direct Add Dialog for an item
  const openDirectAdd = (item: LedgerScanItem) => {
    let matchedAccId = defaultAccountId
    if (item.account_id) {
      matchedAccId = item.account_id
    } else if (item.account_name) {
      const match = accountsList.find((a) =>
        a.name.toLowerCase().includes(item.account_name!.toLowerCase())
      )
      if (match) matchedAccId = match.id
    }

    let matchedCatId = ''
    if (item.category_id) {
      matchedCatId = item.category_id
    } else if (item.category_name) {
      const match = categoriesList.find((c) =>
        c.name.toLowerCase().includes(item.category_name!.toLowerCase())
      )
      if (match) matchedCatId = match.id
    }

    setQuickAddModal({
      open: true,
      item,
      accountId: matchedAccId,
      categoryId: matchedCatId,
      payeeName: item.payee_name || '',
      notes: item.notes || item.raw_text || '',
      isTransfer: Boolean(item.is_transfer),
      targetAccountId: item.transfer_target_account_id || '',
    })
  }

  // Batch Direct Add All Missing Items from Scan
  const batchAddMissingMutation = useMutation({
    mutationFn: async () => {
      const missing = comparisonResults.missingInSecuro
      if (missing.length === 0) return

      const itemsToSave = missing.map((item) => ({
        date: item.date,
        type: item.type,
        amount: Number(item.amount),
        description: item.description,
        account_id: item.account_id || defaultAccountId,
        category_id: item.category_id || undefined,
        payee_name: item.payee_name || undefined,
        notes: item.notes || item.raw_text || undefined,
        is_transfer: item.is_transfer,
        transfer_target_account_id: item.transfer_target_account_id || undefined,
      }))

      return transactionsApi.bulkSaveLedger(itemsToSave)
    },
    onSuccess: (data) => {
      invalidateFinancialQueries(queryClient)
      toast.success(`Saved ${data?.created_count ?? 0} missing transactions directly to Day Book!`)
      setScanCompareModalOpen(false)
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || err?.message || 'Failed to save transactions')
    },
  })

  // Edit / Save transaction via TransactionDialog
  const handleSaveTransactionFromDialog = async (data: TransactionSavePayload) => {
    try {
      if (editingTx) {
        await transactionsApi.update(editingTx.id, data)
        toast.success('Transaction updated successfully!')
      } else {
        await transactionsApi.create(data)
        toast.success('Transaction created successfully!')
      }
      invalidateFinancialQueries(queryClient)
      setTxDialogOpen(false)
      setEditingTx(null)
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || err?.message || 'Failed to save transaction')
    }
  }

  const handleDeleteTransaction = async () => {
    if (!editingTx) return
    try {
      await transactionsApi.delete(editingTx.id)
      invalidateFinancialQueries(queryClient)
      toast.success('Transaction deleted!')
      setTxDialogOpen(false)
      setEditingTx(null)
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || err?.message || 'Failed to delete transaction')
    }
  }

  // Render Transfer / Account destination line for a transaction row
  const renderAccountDetails = (tx: Transaction) => {
    const fromAccountName = tx.account_id ? accountMap.get(tx.account_id) : null

    // Check if it's a transfer with a counterpart in the day's transactions
    if (tx.transfer_pair_id) {
      const counterpart = dayTransactions.find(
        (t) => t.id !== tx.id && t.transfer_pair_id === tx.transfer_pair_id
      )
      const counterpartAccountName = counterpart?.account_id
        ? accountMap.get(counterpart.account_id)
        : null

      const sourceName = tx.type === 'debit' ? fromAccountName : counterpartAccountName
      const destName = tx.type === 'debit' ? counterpartAccountName : fromAccountName

      return (
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-primary mt-1">
          <ArrowRightLeft className="h-3 w-3 shrink-0 text-primary" />
          <span>Transfer:</span>
          <span className="font-semibold text-foreground">{sourceName || 'Source'}</span>
          <ArrowRight className="h-3 w-3 text-muted-foreground" />
          <span className="font-semibold text-foreground">{destName || 'Destination'}</span>
        </div>
      )
    }

    // Direct bank payment / expense to payee
    if (fromAccountName && tx.payee) {
      return (
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-0.5">
          <span className="font-medium text-foreground">{fromAccountName}</span>
          <ArrowRight className="h-2.5 w-2.5 text-muted-foreground" />
          <span className="font-medium text-foreground">{tx.payee}</span>
        </div>
      )
    }

    if (fromAccountName) {
      return (
        <div className="text-[11px] text-muted-foreground mt-0.5">
          Account: <span className="font-medium text-foreground">{fromAccountName}</span>
        </div>
      )
    }

    return null
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Top Header */}
      <PageHeader
        section="ANALYSIS"
        title="Day Book (रोज़नामचा)"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept="image/*"
              className="hidden"
            />

            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={isScanning}
              className="gap-1.5"
            >
              {isScanning ? (
                <RefreshCw className="h-4 w-4 animate-spin text-primary" />
              ) : (
                <ScanLine className="h-4 w-4 text-primary" />
              )}
              {isScanning ? 'Scanning...' : 'Scan / Compare Handwritten Page'}
            </Button>

            <Button
              variant="default"
              size="sm"
              onClick={() => {
                setEditingTx(null)
                setTxDialogOpen(true)
              }}
              className="gap-1.5"
            >
              <Plus className="h-4 w-4" />
              + Direct Add Entry
            </Button>
          </div>
        }
      />

      {/* Date Navigation & Test Samples Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 rounded-xl border bg-card/60 backdrop-blur shadow-sm">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => shiftDate(-1)}
            title="Previous Day"
            className="h-9 w-9"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-background text-sm font-medium">
            <CalendarIcon className="h-4 w-4 text-muted-foreground" />
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => handleDateChange(e.target.value)}
              className="bg-transparent border-none outline-none font-semibold text-foreground cursor-pointer"
            />
          </div>

          <Button
            variant="outline"
            size="icon"
            onClick={() => shiftDate(1)}
            title="Next Day"
            className="h-9 w-9"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleDateChange(new Date().toISOString().slice(0, 10))}
            className="text-xs text-muted-foreground"
          >
            Today
          </Button>
        </div>

        {/* Quick Sample Scan Loaders */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground hidden md:inline">Test Scans:</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadSampleScan(SAMPLE_PAGE_27_07_2026)}
            className="text-xs h-8"
          >
            <Sparkles className="h-3 w-3 mr-1 text-amber-500" />
            Compare 27/7/26 Scan ({formatRupee(39131)})
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadSampleScan(SAMPLE_PAGE_03_08_2026)}
            className="text-xs h-8"
          >
            <Sparkles className="h-3 w-3 mr-1 text-emerald-500" />
            Compare 3/8/26 Scan ({formatRupee(278538)})
          </Button>
        </div>
      </div>

      {/* Top Metrics Bar: B/F, Total Left, Total Right, C/F */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="bg-card/50 border-border/70">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground font-medium">B/F Opening Balance</div>
            <div className="text-xl font-bold text-foreground mt-0.5 tracking-tight font-mono">
              B/F {formatRupee(openingBF)}
            </div>
            {openingBFBreakdown && (
              <div className="text-[11px] font-mono text-muted-foreground mt-1 bg-muted/60 px-1.5 py-0.5 rounded w-fit">
                {openingBFBreakdown}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-border/70">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground font-medium">Total Left (Aamad)</div>
            <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400 mt-0.5 tracking-tight font-mono">
              {formatRupee(leftTotal)}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">
              Receipts: {formatRupee(totalReceipts)} ({dayReceipts.length} entries)
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-border/70">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground font-medium">Total Right (Kharch + C/F)</div>
            <div className="text-xl font-bold text-indigo-600 dark:text-indigo-400 mt-0.5 tracking-tight font-mono">
              {formatRupee(rightTotal)}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">
              Payments: {formatRupee(totalPayments)} ({dayPayments.length} entries)
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-border/70">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground font-medium">C/F Closing Balance</div>
            <div className="text-xl font-bold text-foreground mt-0.5 tracking-tight font-mono">
              C/F {formatRupee(closingCF)}
            </div>
            {closingCFBreakdown && (
              <div className="text-[11px] font-mono text-muted-foreground mt-1 bg-muted/60 px-1.5 py-0.5 rounded w-fit">
                {closingCFBreakdown}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Balanced Verification Banner */}
      <div className="flex items-center justify-between p-3.5 rounded-lg border bg-muted/40 text-sm">
        <div className="flex items-center gap-3">
          {isBalanced ? (
            <Badge variant="default" className="bg-emerald-600 hover:bg-emerald-600 text-white gap-1 px-2.5 py-1">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Day Book Balanced: Left {formatRupee(leftTotal)} = Right {formatRupee(rightTotal)}
            </Badge>
          ) : (
            <Badge variant="destructive" className="gap-1 px-2.5 py-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              Difference: {formatRupee(Math.abs(leftTotal - rightTotal))}
            </Badge>
          )}

          <span className="text-xs text-muted-foreground">
            Displaying <strong>{dayTransactions.length}</strong> recorded transactions for {selectedDate} • Tap any row to view or edit
          </span>
        </div>

        {scanPreview && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setScanCompareModalOpen(true)}
            className="text-xs h-8 gap-1.5"
          >
            <ScanLine className="h-3.5 w-3.5 text-primary" />
            View Scan Comparison ({comparisonResults.missingInSecuro.length} missing)
          </Button>
        )}
      </div>

      {/* Authentic T-Book Ledger View Formatted from Transaction History */}
      <div className="rounded-xl border border-border/80 bg-card shadow-sm overflow-hidden font-sans">
        {/* Ledger Notebook Header */}
        <div className="px-5 py-3.5 bg-muted/70 border-b flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <BookOpen className="h-4 w-4 text-primary" />
            <span className="font-mono font-bold text-sm tracking-wide">
              DATE: {selectedDate.split('-').reverse().join('/')}
            </span>
          </div>
          <span className="text-xs text-muted-foreground uppercase tracking-widest font-semibold">
            T-Format Daily Cash & Bank Register (Tap any row to edit)
          </span>
        </div>

        {/* Dual Column Layout */}
        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x border-b">
          {/* LEFT COLUMN: RECEIPTS / AAMAD (CREDITS / INFLOWS) */}
          <div className="flex flex-col justify-between bg-emerald-500/[0.02]">
            <div>
              <div className="px-4 py-2.5 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 font-semibold text-xs border-b flex items-center justify-between">
                <span>RECEIPTS / AAMAD (आवक / नामे)</span>
                <span>INFLOW</span>
              </div>

              <div className="p-4 divide-y divide-border/40 space-y-3">
                {/* B/F Opening Row */}
                <div className="pb-2 flex items-start justify-between gap-3">
                  <span className="font-mono font-bold text-sm text-foreground shrink-0">
                    B/F {formatRupee(openingBF)}
                  </span>
                  <div className="text-right text-xs text-muted-foreground">
                    <span>Brought Forward</span>
                    {openingBFBreakdown && (
                      <span className="ml-1.5 font-mono text-[11px] bg-muted px-1.5 py-0.5 rounded">
                        {openingBFBreakdown}
                      </span>
                    )}
                  </div>
                </div>

                {/* Left Transaction Rows from History (Tappable for Edit) */}
                {dayReceipts.length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted-foreground italic">
                    No receipts recorded for this date yet.
                  </div>
                ) : (
                  dayReceipts.map((tx) => (
                    <div
                      key={tx.id}
                      onClick={() => {
                        setEditingTx(tx)
                        setTxDialogOpen(true)
                      }}
                      className="pt-2.5 p-2 rounded-lg hover:bg-muted/60 transition-colors cursor-pointer group"
                      title="Tap to view / edit transaction"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span className="font-mono font-semibold text-sm text-foreground shrink-0">
                          {formatRupee(Math.abs(Number(tx.amount)))}
                        </span>
                        <div className="flex-1 text-right">
                          <div className="text-xs font-medium text-foreground flex items-center justify-end gap-1">
                            <span>{tx.description || tx.payee || 'Receipt'}</span>
                            <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                          {renderAccountDetails(tx)}
                          {tx.notes && (
                            <div className="text-[10px] text-muted-foreground italic mt-0.5">
                              {tx.notes}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Left Column Total */}
            <div className="p-4 bg-muted/40 border-t border-double border-t-2 font-mono font-bold text-sm flex items-center justify-between text-foreground">
              <span>LEFT TOTAL</span>
              <span className="text-base text-emerald-600 dark:text-emerald-400">
                {formatRupee(leftTotal)}
              </span>
            </div>
          </div>

          {/* RIGHT COLUMN: PAYMENTS / KHARCH / TRANSFERS (DEBITS / OUTFLOWS) */}
          <div className="flex flex-col justify-between bg-indigo-500/[0.02]">
            <div>
              <div className="px-4 py-2.5 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 font-semibold text-xs border-b flex items-center justify-between">
                <span>PAYMENTS / KHARCH (जावक / खर्चे)</span>
                <span>OUTFLOW</span>
              </div>

              <div className="p-4 divide-y divide-border/40 space-y-3">
                {/* Right Transaction Rows from History (Tappable for Edit) */}
                {dayPayments.length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted-foreground italic">
                    No payments recorded for this date yet.
                  </div>
                ) : (
                  dayPayments.map((tx) => (
                    <div
                      key={tx.id}
                      onClick={() => {
                        setEditingTx(tx)
                        setTxDialogOpen(true)
                      }}
                      className="pt-2.5 p-2 rounded-lg hover:bg-muted/60 transition-colors cursor-pointer group"
                      title="Tap to view / edit transaction"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span className="font-mono font-semibold text-sm text-foreground shrink-0">
                          {formatRupee(Math.abs(Number(tx.amount)))}
                        </span>
                        <div className="flex-1 text-right">
                          <div className="text-xs font-medium text-foreground flex items-center justify-end gap-1">
                            <span>{tx.description || tx.payee || 'Payment'}</span>
                            <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                          {renderAccountDetails(tx)}
                          {tx.notes && (
                            <div className="text-[10px] text-muted-foreground italic mt-0.5">
                              {tx.notes}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}

                {/* Subtotal of Payments */}
                <div className="pt-3 border-t font-mono text-xs flex items-center justify-between text-muted-foreground">
                  <span>Payments Subtotal</span>
                  <span>{formatRupee(totalPayments)}</span>
                </div>

                {/* C/F Closing Row */}
                <div className="pt-2 flex items-start justify-between gap-3">
                  <span className="font-mono font-bold text-sm text-foreground shrink-0">
                    C/F {formatRupee(closingCF)}
                  </span>
                  <div className="text-right text-xs text-muted-foreground">
                    <span>Carried Forward</span>
                    {closingCFBreakdown && (
                      <span className="ml-1.5 font-mono text-[11px] bg-muted px-1.5 py-0.5 rounded">
                        {closingCFBreakdown}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column Grand Total */}
            <div className="p-4 bg-muted/40 border-t border-double border-t-2 font-mono font-bold text-sm flex items-center justify-between text-foreground">
              <span>RIGHT TOTAL</span>
              <span className="text-base text-indigo-600 dark:text-indigo-400">
                {formatRupee(rightTotal)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* SCAN COMPARISON & DIRECT SAVE MODAL POPUP */}
      <Dialog open={scanCompareModalOpen} onOpenChange={setScanCompareModalOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col overflow-hidden">
          <DialogHeader className="border-b pb-3">
            <div className="flex items-center justify-between pr-4">
              <div>
                <DialogTitle className="text-base font-semibold flex items-center gap-2">
                  <ScanLine className="h-4 w-4 text-primary" />
                  Handwritten Ledger Comparison & Direct Add
                </DialogTitle>
                <DialogDescription className="text-xs">
                  Review scanned handwritten transactions for {scanPreview?.page_date || selectedDate} and save missing items directly to Securo.
                </DialogDescription>
              </div>

              {scanPreview && (
                <div className="text-right font-mono text-xs">
                  <span className="text-muted-foreground">Page Total: </span>
                  <span className="font-bold text-foreground">
                    {formatRupee(Number(scanPreview.left_total || 0))}
                  </span>
                </div>
              )}
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto py-3 space-y-4 pr-1 text-xs">
            {/* Reconciliation Stat Pill */}
            <div className="flex items-center justify-between p-2.5 rounded-lg border bg-muted/50 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Comparison Summary:</span>
                <Badge variant="outline" className="border-emerald-500/30 text-emerald-600 bg-emerald-500/5">
                  {comparisonResults.matched.length} Matched in Securo
                </Badge>
                <Badge
                  variant={comparisonResults.missingInSecuro.length > 0 ? 'default' : 'outline'}
                  className={cn(
                    comparisonResults.missingInSecuro.length > 0
                      ? 'bg-amber-600 text-white'
                      : 'border-emerald-500 text-emerald-600'
                  )}
                >
                  {comparisonResults.missingInSecuro.length} Missing from Securo
                </Badge>
              </div>

              {comparisonResults.missingInSecuro.length > 0 && (
                <Button
                  size="sm"
                  onClick={() => batchAddMissingMutation.mutate()}
                  disabled={batchAddMissingMutation.isPending}
                  className="h-7 text-xs px-2.5 gap-1.5 bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {batchAddMissingMutation.isPending ? (
                    <RefreshCw className="h-3 w-3 animate-spin" />
                  ) : (
                    <Plus className="h-3 w-3" />
                  )}
                  Save All Missing Directly ({comparisonResults.missingInSecuro.length})
                </Button>
              )}
            </div>

            {/* Missing Items List (Needs direct saving) */}
            <div className="space-y-2">
              <h4 className="font-semibold text-xs flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                <AlertCircle className="h-3.5 w-3.5" />
                Missing from Securo (Add Directly)
              </h4>

              {comparisonResults.missingInSecuro.length === 0 ? (
                <div className="p-4 rounded-lg border border-dashed text-center text-muted-foreground">
                  <CheckCircle2 className="h-6 w-6 text-emerald-500 mx-auto mb-1" />
                  All transactions from this handwritten page are already in Securo!
                </div>
              ) : (
                comparisonResults.missingInSecuro.map((item) => (
                  <div
                    key={item.id}
                    className="p-3 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-500/[0.03] flex items-center justify-between gap-3"
                  >
                    <div className="space-y-1 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-sm text-foreground">
                          {formatRupee(Number(item.amount))}
                        </span>
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[10px] px-1.5 py-0',
                            item.type === 'credit'
                              ? 'border-emerald-500/40 text-emerald-600'
                              : 'border-indigo-500/40 text-indigo-600'
                          )}
                        >
                          {item.type === 'credit' ? 'Receipt' : 'Payment'}
                        </Badge>
                        <span className="font-medium text-foreground">{item.description}</span>
                      </div>

                      {/* Display source and destination clearly */}
                      {item.is_transfer ? (
                        <div className="flex items-center gap-1.5 text-[11px] text-primary font-medium">
                          <ArrowRightLeft className="h-3 w-3" />
                          <span>Transfer:</span>
                          <span>{item.account_name || 'Source Account'}</span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          <span>{item.transfer_target_account_name || 'Target Account'}</span>
                        </div>
                      ) : (
                        <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                          <span>Account: {item.account_name || 'Cash - Wallet'}</span>
                          {item.payee_name && (
                            <>
                              <ArrowRight className="h-2.5 w-2.5 text-muted-foreground" />
                              <span className="font-medium text-foreground">Payee: {item.payee_name}</span>
                            </>
                          )}
                        </div>
                      )}

                      {item.raw_text && item.raw_text !== item.description && (
                        <div className="text-[11px] text-muted-foreground italic">
                          &ldquo;{item.raw_text}&rdquo;
                        </div>
                      )}
                    </div>

                    <Button
                      size="sm"
                      onClick={() => openDirectAdd(item)}
                      className="h-7 text-xs px-2.5 gap-1 bg-amber-600 hover:bg-amber-700 text-white shrink-0"
                    >
                      <Plus className="h-3 w-3" />
                      Save Directly
                    </Button>
                  </div>
                ))
              )}
            </div>

            {/* Already Matched Items */}
            {comparisonResults.matched.length > 0 && (
              <div className="space-y-2 pt-2 border-t">
                <h4 className="font-semibold text-xs flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Already Reconciled in Securo ({comparisonResults.matched.length})
                </h4>

                <div className="space-y-1.5">
                  {comparisonResults.matched.map((m, idx) => (
                    <div
                      key={idx}
                      className="p-2 rounded border border-emerald-200 dark:border-emerald-950/40 bg-emerald-500/[0.02] flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                        <span className="font-mono font-medium">{formatRupee(Number(m.scanned.amount))}</span>
                        <span>{m.scanned.description}</span>
                      </div>
                      <span className="text-muted-foreground text-[11px]">
                        Matches: {m.recorded.description || m.recorded.payee}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="border-t pt-3 flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              Saved items will immediately appear in your Day Book.
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setScanCompareModalOpen(false)}
              className="text-xs"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* FULL TRANSACTION VIEW / EDIT DIALOG (OPENS ON TAP) */}
      <TransactionDialog
        open={txDialogOpen}
        onClose={() => {
          setTxDialogOpen(false)
          setEditingTx(null)
        }}
        transaction={editingTx}
        categories={categoriesList}
        categoryGroups={categoryGroupsList}
        accounts={accountsList}
        onSave={handleSaveTransactionFromDialog}
        onDelete={editingTx ? handleDeleteTransaction : undefined}
        loading={false}
        error={null}
      />

      {/* SINGLE ITEM DIRECT ADD MODAL (FROM MISSING SCAN) */}
      <Dialog
        open={quickAddModal.open}
        onOpenChange={(open) => setQuickAddModal((prev) => ({ ...prev, open }))}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              Save Transaction Directly
            </DialogTitle>
            <DialogDescription className="text-xs">
              Confirm details to add directly to your workspace and day book.
            </DialogDescription>
          </DialogHeader>

          {quickAddModal.item && (
            <div className="space-y-3 py-2 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-[11px]">Date</Label>
                  <Input
                    type="date"
                    value={quickAddModal.item.date}
                    onChange={(e) =>
                      setQuickAddModal((prev) => ({
                        ...prev,
                        item: prev.item ? { ...prev.item, date: e.target.value } : null,
                      }))
                    }
                    className="h-8 text-xs font-mono"
                  />
                </div>
                <div>
                  <Label className="text-[11px]">Type</Label>
                  <Select
                    value={quickAddModal.item.type}
                    onValueChange={(val: any) =>
                      setQuickAddModal((prev) => ({
                        ...prev,
                        item: prev.item ? { ...prev.item, type: val } : null,
                      }))
                    }
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="credit">Receipt (Credit)</SelectItem>
                      <SelectItem value="debit">Payment (Debit)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label className="text-[11px]">Amount (₹)</Label>
                <Input
                  type="number"
                  step="any"
                  value={quickAddModal.item.amount}
                  onChange={(e) =>
                    setQuickAddModal((prev) => ({
                      ...prev,
                      item: prev.item ? { ...prev.item, amount: Number(e.target.value) } : null,
                    }))
                  }
                  className="h-8 text-xs font-mono font-bold"
                />
              </div>

              <div>
                <Label className="text-[11px]">Description / Narration</Label>
                <Input
                  value={quickAddModal.item.description}
                  onChange={(e) =>
                    setQuickAddModal((prev) => ({
                      ...prev,
                      item: prev.item ? { ...prev.item, description: e.target.value } : null,
                    }))
                  }
                  className="h-8 text-xs"
                />
              </div>

              <div>
                <Label className="text-[11px]">Source Account</Label>
                <Select
                  value={quickAddModal.accountId}
                  onValueChange={(val) =>
                    setQuickAddModal((prev) => ({ ...prev, accountId: val }))
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Select account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accountsList.map((acc) => (
                      <SelectItem key={acc.id} value={acc.id} className="text-xs">
                        {acc.name} ({acc.currency})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {quickAddModal.isTransfer && (
                <div>
                  <Label className="text-[11px]">Destination Account (Transfer To)</Label>
                  <Select
                    value={quickAddModal.targetAccountId}
                    onValueChange={(val) =>
                      setQuickAddModal((prev) => ({ ...prev, targetAccountId: val }))
                    }
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Select destination account" />
                    </SelectTrigger>
                    <SelectContent>
                      {accountsList.map((acc) => (
                        <SelectItem key={acc.id} value={acc.id} className="text-xs">
                          {acc.name} ({acc.currency})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div>
                <Label className="text-[11px]">Category (Optional)</Label>
                <CategorySelect
                  value={quickAddModal.categoryId}
                  onChange={(val) =>
                    setQuickAddModal((prev) => ({ ...prev, categoryId: val }))
                  }
                  categories={categoriesList}
                  groups={categoryGroupsList}
                  placeholder="Select category"
                  allowNone
                  className="h-8 text-xs"
                />
              </div>

              <div>
                <Label className="text-[11px]">Payee (Optional)</Label>
                <Input
                  value={quickAddModal.payeeName}
                  onChange={(e) =>
                    setQuickAddModal((prev) => ({ ...prev, payeeName: e.target.value }))
                  }
                  placeholder="Payee or entity name"
                  className="h-8 text-xs"
                />
              </div>

              <div>
                <Label className="text-[11px]">Notes / Raw Text</Label>
                <Input
                  value={quickAddModal.notes}
                  onChange={(e) =>
                    setQuickAddModal((prev) => ({ ...prev, notes: e.target.value }))
                  }
                  placeholder="Additional notes"
                  className="h-8 text-xs"
                />
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setQuickAddModal((prev) => ({ ...prev, open: false }))}
              className="text-xs"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={
                !quickAddModal.item ||
                !quickAddModal.accountId ||
                createTxMutation.isPending
              }
              onClick={() => {
                if (!quickAddModal.item || !quickAddModal.accountId) return
                createTxMutation.mutate({
                  account_id: quickAddModal.accountId,
                  amount: Number(quickAddModal.item.amount),
                  date: quickAddModal.item.date,
                  type: quickAddModal.item.type,
                  description: quickAddModal.item.description,
                  category_id: quickAddModal.categoryId || null,
                  payee_name: quickAddModal.payeeName || null,
                  notes: quickAddModal.notes || null,
                  is_transfer: quickAddModal.isTransfer,
                  transfer_target_account_id: quickAddModal.targetAccountId || null,
                })
              }}
              className="text-xs gap-1.5"
            >
              {createTxMutation.isPending ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Save Directly
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
