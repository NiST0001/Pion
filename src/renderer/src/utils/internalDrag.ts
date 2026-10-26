interface InternalDragReceipt {
  source: object
  data: { cwd: string }
  payload: string
  owner: object
  isCurrent: () => boolean
}

// Renderer-local UI lifecycle receipt, with no authentication or OS isolation role.
let activeDrag: InternalDragReceipt | null = null

export function createInternalDrag<T extends { cwd: string }>(
  mime: string,
  snapshot: (data: T) => T,
) {
  const source = {}

  return {
    begin(
      transfer: Pick<DataTransfer, 'setData'>,
      data: T,
      owner: object,
      isCurrent: () => boolean,
    ): boolean {
      activeDrag = null
      try {
        if (!isCurrent()) return false
        const copied = snapshot(data)
        const payload = JSON.stringify({ version: 1, ...copied })
        transfer.setData(mime, payload)
        activeDrag = { source, data: copied, payload, owner, isCurrent }
        return true
      } catch {
        return false
      }
    },

    get(
      transfer: Pick<DataTransfer, 'types' | 'getData'>,
      cwd: string,
      phase: 'over' | 'drop',
    ): T | null {
      const receipt = activeDrag
      if (!receipt || receipt.source !== source) return null
      // Consume before validation, including rejected drops and throwing callbacks.
      if (phase === 'drop') activeDrag = null
      try {
        if (!transfer.types.includes(mime)
          || receipt.data.cwd !== cwd
          || !receipt.isCurrent()) return null
        // Native dragover uses protected mode: only the MIME list is available.
        if (phase === 'drop' && transfer.getData(mime) !== receipt.payload) return null
        // The private source identity ties this receipt to this factory's T.
        return { ...receipt.data } as T
      } catch {
        return null
      }
    },

    end(owner: object): void {
      if (activeDrag?.source === source && activeDrag.owner === owner) activeDrag = null
    },
  }
}
