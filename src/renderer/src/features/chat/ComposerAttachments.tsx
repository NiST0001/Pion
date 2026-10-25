import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, ReactElement } from 'react'
import { FileText, ImagePlus, Loader2, X } from 'lucide-react'
import type { ImageContent } from '../../../../shared/types'
import { attachmentReferenceToken, referenceToken } from './composerReferences'
import type { ReferenceAttachment } from './composerReferences'
import { ReferencePreviewDialog } from './ReferencePreviewDialog'

// Numbering may change without replacing the underlying attachment.
function sameAttachment(left: ReferenceAttachment, right: ReferenceAttachment): boolean {
  return left.id === right.id && left.kind === right.kind && left.name === right.name
    && left.mimeType === right.mimeType && left.size === right.size
    && (left.kind === 'image'
      ? right.kind === 'image' && left.image.data === right.image.data && left.image.mimeType === right.image.mimeType
      : right.kind === 'text' && left.content === right.content)
}

export function ComposerAttachments({
  references,
  pendingImages,
  reading,
  error,
  disabled,
  scopeKey = '',
  onInsertToken,
  onRemove
}: {
  references: ReferenceAttachment[]
  pendingImages: ImageContent[]
  reading: boolean
  error: string
  disabled: boolean
  scopeKey?: string
  onInsertToken: (id: string) => void
  onRemove: (id: string) => void
}): ReactElement {
  // A fresh owner on every scope transition also retires A → B → A callbacks.
  const owner = useMemo(() => ({ scopeKey }), [scopeKey])
  type OwnedReference = { reference: ReferenceAttachment; owner: typeof owner }
  const [preview, setPreview] = useState<OwnedReference | null>(null)
  const current = useRef({ references, disabled, onInsertToken, owner })
  const pending = useRef<(OwnedReference & { timer: ReturnType<typeof setTimeout> }) | null>(null)
  const restorePreviewFocus = useRef(true)
  const cancelPreview = (): void => {
    if (pending.current) clearTimeout(pending.current.timer)
    pending.current = null
  }
  const findCurrent = (candidate: OwnedReference): ReferenceAttachment | undefined =>
    current.current.disabled || current.current.owner !== candidate.owner ? undefined
      : current.current.references.find((item) => sameAttachment(item, candidate.reference))
  const openPreview = (candidate: OwnedReference): void => {
    const attachment = findCurrent(candidate)
    // A confirmation opened during the delay owns focus; never cover it.
    if (attachment && !document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')) {
      restorePreviewFocus.current = true
      setPreview({ ...candidate, reference: attachment })
    }
  }

  useLayoutEffect(() => {
    current.current = { references, disabled, onInsertToken, owner }
    if (pending.current && !findCurrent(pending.current)) cancelPreview()
    if (preview && !findCurrent(preview)) setPreview(null)
  }, [references, disabled, onInsertToken, owner, preview])
  useLayoutEffect(() => () => cancelPreview(), [])

  const previewClick = (event: MouseEvent<HTMLButtonElement>, reference: ReferenceAttachment): void => {
    cancelPreview()
    const candidate = { reference, owner }
    if (!findCurrent(candidate) || event.detail > 1) return
    if (event.detail === 0) {
      openPreview(candidate)
      return
    }
    // Application-defined 500 ms split, not the user's native double-click setting.
    pending.current = {
      ...candidate,
      timer: setTimeout(() => {
        pending.current = null
        openPreview(candidate)
      }, 500)
    }
  }
  const pressReference = (event: MouseEvent<HTMLButtonElement>): void => {
    // Cancel on the second press, even if it is held across the preview deadline.
    if (event.detail >= 2) cancelPreview()
  }
  const insertReference = (reference: ReferenceAttachment): void => {
    cancelPreview()
    if (!findCurrent({ reference, owner })) return
    restorePreviewFocus.current = false
    setPreview(null)
    current.current.onInsertToken(reference.id)
  }
  const visiblePreview = preview && preview.owner === owner && !disabled
    && references.find((item) => sameAttachment(item, preview.reference))

  return (
    <div
      className="composer-attachments"
      aria-label={references.some((reference) => reference.kind === 'text') ? '待发送图像和参考' : '待发送图像'}
    >
      <div className="composer-attachment-list">
        {references.map((reference) => (
          <div
            className={`composer-attachment${reference.kind === 'text' ? ' composer-attachment-file' : ''}`}
            key={reference.id}
            title={`${reference.name} · ${reference.kind === 'image' ? '图像参考' : '文本参考'}`}
          >
            {reference.kind === 'image' ? (
              <>
                <button
                  type="button"
                  className="composer-reference-trigger"
                  style={{ width: '100%', height: '100%', padding: 0, borderRadius: 'inherit' }}
                  disabled={disabled}
                  title={`单击预览 · 双击插入 ${attachmentReferenceToken(reference)} · ${reference.name}`}
                  aria-label={`预览图像 ${reference.imageNumber}`}
                  onPointerDown={pressReference}
                  onMouseDown={(event) => { event.preventDefault(); pressReference(event) }}
                  onClick={(event) => previewClick(event, reference)}
                  onDoubleClick={() => insertReference(reference)}
                >
                  <img
                    src={`data:${reference.image.mimeType};base64,${reference.image.data}`}
                    alt={`待发送图像 ${reference.imageNumber}`}
                  />
                  <span className="composer-attachment-index">图像 {reference.imageNumber}</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="composer-reference-trigger composer-attachment-text-trigger"
                  disabled={disabled}
                  title={`单击预览 · 双击插入 ${attachmentReferenceToken(reference)}`}
                  aria-label={`预览参考 ${reference.name}`}
                  onPointerDown={pressReference}
                  onMouseDown={(event) => { event.preventDefault(); pressReference(event) }}
                  onClick={(event) => previewClick(event, reference)}
                  onDoubleClick={() => insertReference(reference)}
                >
                  <FileText size={16} aria-hidden="true" />
                  <span>{referenceToken(reference.name)}</span>
                </button>
              </>
            )}
            <button
              type="button"
              className="composer-attachment-remove"
              title={reference.kind === 'image' ? '移除图像' : `移除 ${reference.name}`}
              aria-label={reference.kind === 'image'
                ? `移除第 ${reference.imageNumber} 张图像`
                : `移除参考 ${reference.name}`}
              disabled={disabled}
              onClick={() => {
                if (pending.current?.reference.id === reference.id) cancelPreview()
                if (preview?.reference.id === reference.id) setPreview(null)
                onRemove(reference.id)
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
        {pendingImages.length > 0 && (
          <span className="composer-attachment-label">
            <ImagePlus size={13} />
            {pendingImages.length} 张图像待发送
          </span>
        )}
        {references.some((reference) => reference.kind === 'text') && (
          <span className="composer-attachment-label">
            <FileText size={13} />
            {references.filter((reference) => reference.kind === 'text').length} 个文件
          </span>
        )}
        {reading && (
          <span className="composer-attachment-label">
            <Loader2 size={13} className="spin" />
            正在读取参考…
          </span>
        )}
      </div>
      {error && <span className="composer-attachment-error">{error}</span>}
      {visiblePreview && (
        <ReferencePreviewDialog
          reference={visiblePreview}
          onClose={() => setPreview(null)}
          restoreFocus={restorePreviewFocus}
        />
      )}
    </div>
  )
}
