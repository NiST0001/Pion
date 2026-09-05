import type { ReactElement } from 'react'
import { FileText, ImagePlus, Loader2, X } from 'lucide-react'
import type { ImageContent } from '../../../../shared/types'
import { referenceToken } from './composerReferences'
import type { ReferenceAttachment } from './composerReferences'

export function ComposerAttachments({
  references,
  pendingImages,
  reading,
  error,
  onRemove
}: {
  references: ReferenceAttachment[]
  pendingImages: ImageContent[]
  reading: boolean
  error: string
  onRemove: (id: string) => void
}): ReactElement {
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
              <img
                src={`data:${reference.image.mimeType};base64,${reference.image.data}`}
                alt={`待发送图像 ${pendingImages.indexOf(reference.image) + 1}`}
              />
            ) : (
              <>
                <FileText size={16} aria-hidden="true" />
                <span>{referenceToken(reference.name)}</span>
              </>
            )}
            <button
              type="button"
              className="composer-attachment-remove"
              title={reference.kind === 'image' ? '移除图像' : `移除 ${reference.name}`}
              aria-label={reference.kind === 'image'
                ? `移除第 ${pendingImages.indexOf(reference.image) + 1} 张图像`
                : `移除参考 ${reference.name}`}
              onClick={() => onRemove(reference.id)}
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
    </div>
  )
}
