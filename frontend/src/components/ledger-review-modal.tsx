import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CheckCircle2,
  AlertTriangle,
  Plus,
  Trash2,
  ArrowRightLeft,
  Loader2,
  FileSpreadsheet,
  Check,
  Calendar,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CategorySelect } from '@/components/category-select'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  accounts as accountsApi,
  categories as categoriesApi,
  categoryGroups as categoryGroupsApi,
  payees as payeesApi,
  transactions as transactionsApi,
} from '@/lib/api'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { formatCurrency } from '@/lib/format'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { useAuth } from '@/contexts/auth-context'
import type { LedgerScanItem, LedgerScanPreview, LedgerBulkSaveItem } from '@/types'

interface EditableRow extends LedgerScanItem {
  _id: string
  included: boolean
}

interface LedgerReviewModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  preview: LedgerScanPreview | null
  imageFile?: File | null
  onSuccess?: () => void
}

export function LedgerReviewModal({
  open,
  onOpenChange,
  preview,
  imageFile,
  onSuccess,
}: LedgerReviewModalProps) {
  const queryClient = useQueryClient()
  const locale = useDisplayLocale()
  const { user } = useAuth()
  const userCurrency = user?.preferences?.currency_display ?? 'INR'

  const [date, setDate] = useState<string>('')
  const [rows, setRows] = useState<EditableRow[]>([])
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [showImagePreview, setShowImagePreview] = useState(false)

  // Fetch accounts, categories, and payees for the active workspace
  const { data: accountsList = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => accountsApi.list(),
    enabled: open,
  })

  const { data: categoriesList = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => categoriesApi.list(),
    enabled: open,
  })

  const { data: categoryGroupsList = [] } = useQuery({
    queryKey: ['category-groups'],
    queryFn: () => categoryGroupsApi.list(),
    enabled: open,
  })

  const { data: payeesList = [] } = useQuery({
    queryKey: ['payees'],
    queryFn: () => payeesApi.list(),
    enabled: open,
  })

  // Object URL for image thumbnail
  useEffect(() => {
    if (imageFile) {
      const url = URL.createObjectURL(imageFile)
      setImageUrl(url)
      return () => URL.revokeObjectURL(url)
    } else {
      setImageUrl(null)
    }
  }, [imageFile])

  // Initialize state when preview changes
  useEffect(() => {
    if (preview) {
      setDate(preview.page_date || new Date().toISOString().split('T')[0])
      setRows(
        (preview.transactions || []).map((t, idx) => ({
          ...t,
          _id: t.id || `row-${idx}-${Date.now()}`,
          included: true,
          amount: Number(t.amount) || 0,
        }))
      )
    } else {
      setRows([])
      setDate('')
    }
  }, [preview])

  // Bulk save mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      const selectedRows = rows.filter((r) => r.included && r.account_id && r.amount > 0)
      if (selectedRows.length === 0) {
        throw new Error('Please select at least one valid transaction with an assigned account')
      }

      const items: LedgerBulkSaveItem[] = selectedRows.map((r) => ({
        date: date || r.date,
        type: r.type,
        amount: Number(r.amount),
        description: r.description || (r.type === 'credit' ? 'Sales' : 'Expense'),
        account_id: r.account_id!,
        category_id: r.category_id || null,
        payee_id: r.payee_id || null,
        payee_name: r.payee_name || null,
        notes: r.notes || null,
        is_transfer: Boolean(r.is_transfer),
        transfer_target_account_id: r.transfer_target_account_id || null,
      }))

      return transactionsApi.bulkSaveLedger(items)
    },
    onSuccess: (res) => {
      toast.success(`Successfully saved ${res.created_count} transactions to your workspace!`)
      invalidateFinancialQueries(queryClient)
      onSuccess?.()
      onOpenChange(false)
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || err?.message || 'Failed to save transactions')
    },
  })

  const updateRow = (id: string, updates: Partial<EditableRow>) => {
    setRows((prev) => prev.map((r) => (r._id === id ? { ...r, ...updates } : r)))
  }

  const deleteRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r._id !== id))
  }

  const addEmptyRow = () => {
    const defaultAcc = accountsList[0]?.id || ''
    const newRow: EditableRow = {
      _id: `manual-${Date.now()}`,
      included: true,
      date: date || new Date().toISOString().split('T')[0],
      type: 'debit',
      amount: 0,
      description: 'Misc.',
      account_id: defaultAcc,
      account_name: accountsList[0]?.name || '',
      category_id: null,
      notes: 'Spent by: Factory | Mode: Cash',
      confidence: 1.0,
      is_transfer: false,
    }
    setRows((prev) => [...prev, newRow])
  }

  const toggleAll = (checked: boolean) => {
    setRows((prev) => prev.map((r) => ({ ...r, included: checked })))
  }

  const selectedCount = rows.filter((r) => r.included).length
  const totalAmountSelected = rows
    .filter((r) => r.included)
    .reduce((sum, r) => sum + (r.type === 'credit' ? Number(r.amount) : -Number(r.amount)), 0)

  const isBalanced = preview?.is_balanced ?? true

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[92vh] flex flex-col p-0 gap-0 overflow-hidden">
        {/* Header */}
        <DialogHeader className="px-6 py-4 border-b border-border bg-card/60 shrink-0">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400 flex items-center justify-center font-semibold shrink-0">
                <FileSpreadsheet className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle className="text-lg font-bold">Review Handwritten Ledger</DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground">
                  Verify extracted transactions, adjust categories or payees, and approve for your workspace.
                </DialogDescription>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {imageUrl && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs gap-1.5"
                  onClick={() => setShowImagePreview((v) => !v)}
                >
                  {showImagePreview ? 'Hide Photo' : 'View Photo'}
                </Button>
              )}
              <div className="flex items-center gap-1.5 bg-muted/60 px-2.5 py-1 rounded-md border border-border">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                <Label htmlFor="ledger-date" className="text-xs text-muted-foreground mr-1">
                  Date:
                </Label>
                <input
                  id="ledger-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="bg-transparent text-xs font-medium focus:outline-none border-0 p-0 text-foreground cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* Reconciliation banner */}
          {preview && (
            <div
              className={`mt-3 p-2.5 rounded-lg border flex flex-wrap items-center justify-between gap-2 text-xs transition-colors ${
                isBalanced
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-950 dark:text-emerald-200'
                  : 'bg-amber-500/10 border-amber-500/30 text-amber-950 dark:text-amber-200'
              }`}
            >
              <div className="flex items-center gap-2">
                {isBalanced ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
                )}
                <span className="font-semibold">
                  {isBalanced
                    ? `✓ Ledger Balanced: Left Total (${formatCurrency(Number(preview.left_total || 0), userCurrency, locale)}) == Right Total (${formatCurrency(Number(preview.right_total || 0), userCurrency, locale)})`
                    : `⚠️ Ledger Mismatch: Left Total (${formatCurrency(Number(preview.left_total || 0), userCurrency, locale)}) ≠ Right Total (${formatCurrency(Number(preview.right_total || 0), userCurrency, locale)})`}
                </span>
              </div>

              <div className="flex items-center gap-3 text-[11px] opacity-90 font-mono">
                {preview.opening_balance_bf != null && (
                  <span>
                    B/F (Opening):{' '}
                    <strong>{formatCurrency(Number(preview.opening_balance_bf), userCurrency, locale)}</strong>
                  </span>
                )}
                {preview.closing_balance_cf != null && (
                  <span>
                    C/F (Closing):{' '}
                    <strong>{formatCurrency(Number(preview.closing_balance_cf), userCurrency, locale)}</strong>
                  </span>
                )}
              </div>
            </div>
          )}
        </DialogHeader>

        {/* Collapsible Photo Preview */}
        {showImagePreview && imageUrl && (
          <div className="border-b border-border bg-muted/40 p-3 max-h-56 overflow-auto flex justify-center shrink-0">
            <img
              src={imageUrl}
              alt="Handwritten Ledger Sheet"
              className="max-h-52 rounded border border-border shadow-sm object-contain"
            />
          </div>
        )}

        {/* Table Content */}
        <div className="flex-1 overflow-y-auto px-6 py-3 min-h-[300px]">
          {rows.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground text-sm">
              No transactions detected. Click "+ Add Row" below to create one.
            </div>
          ) : (
            <div className="divide-y divide-border border rounded-lg overflow-hidden bg-card">
              {/* Header Row */}
              <div className="grid grid-cols-[40px_90px_110px_180px_160px_140px_1fr_40px] items-center gap-2 px-3 py-2 bg-muted/50 text-[11px] font-semibold text-muted-foreground">
                <div className="flex items-center justify-center">
                  <input
                    type="checkbox"
                    checked={rows.length > 0 && rows.every((r) => r.included)}
                    onChange={(e) => toggleAll(e.target.checked)}
                    className="h-4 w-4 rounded border-border text-primary focus:ring-primary cursor-pointer"
                    aria-label="Select all"
                  />
                </div>
                <div>TYPE</div>
                <div>AMOUNT</div>
                <div>ACCOUNT</div>
                <div>CATEGORY</div>
                <div>PAYEE</div>
                <div>DETAILS & NOTES</div>
                <div></div>
              </div>

              {/* Data Rows */}
              {rows.map((row) => {
                const categoryObj = categoriesList.find((c) => c.id === row.category_id) || null
                return (
                  <div
                    key={row._id}
                    className={`grid grid-cols-[40px_90px_110px_180px_160px_140px_1fr_40px] items-center gap-2 px-3 py-2.5 transition-colors text-xs ${
                      !row.included ? 'opacity-40 bg-muted/20' : 'hover:bg-muted/30'
                    }`}
                  >
                    {/* Checkbox */}
                    <div className="flex items-center justify-center">
                      <input
                        type="checkbox"
                        checked={row.included}
                        onChange={(e) =>
                          updateRow(row._id, { included: e.target.checked })
                        }
                        className="h-4 w-4 rounded border-border text-primary focus:ring-primary cursor-pointer"
                      />
                    </div>

                    {/* Type Badge / Toggle */}
                    <div>
                      <button
                        type="button"
                        onClick={() =>
                          updateRow(row._id, {
                            type: row.type === 'credit' ? 'debit' : 'credit',
                          })
                        }
                        className={`w-full py-1 px-2 rounded-md font-semibold text-[11px] text-center transition-colors cursor-pointer ${
                          row.type === 'credit'
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/25'
                            : 'bg-rose-500/15 text-rose-700 dark:text-rose-300 hover:bg-rose-500/25'
                        }`}
                        title="Click to toggle Inflow / Outflow"
                      >
                        {row.is_transfer ? (
                          <span className="flex items-center justify-center gap-1">
                            <ArrowRightLeft size={11} /> Transfer
                          </span>
                        ) : row.type === 'credit' ? (
                          '+ Income'
                        ) : (
                          '− Expense'
                        )}
                      </button>
                    </div>

                    {/* Amount Input */}
                    <div>
                      <Input
                        type="number"
                        step="0.01"
                        value={row.amount || ''}
                        onChange={(e) => updateRow(row._id, { amount: Number(e.target.value) })}
                        className="h-8 text-xs font-semibold tabular-nums"
                        placeholder="0.00"
                      />
                    </div>

                    {/* Account Select */}
                    <div>
                      <Select
                        value={row.account_id || ''}
                        onValueChange={(val) => {
                          const acc = accountsList.find((a) => a.id === val)
                          updateRow(row._id, {
                            account_id: val,
                            account_name: acc?.name || '',
                          })
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs truncate">
                          <SelectValue placeholder="Select account..." />
                        </SelectTrigger>
                        <SelectContent>
                          {accountsList.map((acc) => (
                            <SelectItem key={acc.id} value={acc.id} className="text-xs">
                              {acc.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Category Select */}
                    <div>
                      <CategorySelect
                        value={row.category_id || ''}
                        onChange={(val) => updateRow(row._id, { category_id: val || null })}
                        categories={categoriesList}
                        groups={categoryGroupsList}
                        currentCategory={categoryObj}
                        placeholder="Category..."
                        className="h-8 text-xs"
                        allowNone
                      />
                    </div>

                    {/* Payee */}
                    <div>
                      <Input
                        value={row.payee_name || ''}
                        onChange={(e) => updateRow(row._id, { payee_name: e.target.value })}
                        placeholder="Payee..."
                        list="ledger-payees-datalist"
                        className="h-8 text-xs"
                      />
                      <datalist id="ledger-payees-datalist">
                        {payeesList.map((p) => (
                          <option key={p.id} value={p.name} />
                        ))}
                      </datalist>
                    </div>

                    {/* Description & Notes */}
                    <div className="flex flex-col gap-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Input
                          value={row.description || ''}
                          onChange={(e) => updateRow(row._id, { description: e.target.value })}
                          placeholder="Description..."
                          className="h-7 text-xs flex-1 font-medium"
                        />
                        {row.raw_text && (
                          <span
                            className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded truncate max-w-[120px]"
                            title={`Original line: ${row.raw_text}`}
                          >
                            {row.raw_text}
                          </span>
                        )}
                      </div>
                      <Input
                        value={row.notes || ''}
                        onChange={(e) => updateRow(row._id, { notes: e.target.value })}
                        placeholder="Notes / Tags (e.g. Spent by: Factory | Mode: Cash)"
                        className="h-6 text-[11px] text-muted-foreground"
                      />
                    </div>

                    {/* Delete Action */}
                    <div className="flex justify-center">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-rose-500"
                        onClick={() => deleteRow(row._id)}
                        title="Remove row"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="mt-3 flex items-center justify-between">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addEmptyRow}
              className="h-8 text-xs gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" /> Add Row
            </Button>

            <span className="text-xs text-muted-foreground">
              {selectedCount} of {rows.length} transactions included
            </span>
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="px-6 py-3 border-t border-border bg-card/60 flex items-center justify-between shrink-0 sm:justify-between">
          <div className="text-xs font-medium text-muted-foreground">
            Net Selected Movement:{' '}
            <strong
              className={`tabular-nums ${
                totalAmountSelected >= 0 ? 'text-emerald-600' : 'text-rose-500'
              }`}
            >
              {totalAmountSelected >= 0 ? '+' : ''}
              {formatCurrency(totalAmountSelected, userCurrency, locale)}
            </strong>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => onOpenChange(false)}
              disabled={saveMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 text-xs gap-1.5 px-4 font-semibold"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || selectedCount === 0}
            >
              {saveMutation.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving...
                </>
              ) : (
                <>
                  <Check className="h-3.5 w-3.5" /> Approve & Save ({selectedCount})
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
