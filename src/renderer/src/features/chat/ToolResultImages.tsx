import { memo, useState } from 'react'
import type { ReactElement } from 'react'
import type { ToolResultImage } from '../../../../shared/tool-images'

const ToolImagePreview = memo(function ToolImagePreview({ image, number }: {
  image: ToolResultImage
  number: number
}): ReactElement {
  const [settled, setSettled] = useState<{ image: ToolResultImage; failed: boolean } | null>(null)
  const current = settled && settled.image.data === image.data && settled.image.mimeType === image.mimeType
    ? settled : null
  const state = current ? current.failed ? 'failed' : 'loaded' : 'loading'

  return (
    <figure className="tool-result-image">
      <div className="tool-result-image-frame" data-image-state={state}>
        {state !== 'failed' && (
          <img
            src={`data:${image.mimeType};base64,${image.data}`}
            alt={`工具结果预览 ${number}`}
            width={image.width}
            height={image.height}
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => setSettled({ image, failed: false })}
            onError={() => setSettled({ image, failed: true })}
          />
        )}
        {state !== 'loaded' && (
          <span className="tool-result-image-status">
            {state === 'failed' ? '预览加载失败，请查看工具输出中的原图路径。' : '图片预览加载中…'}
          </span>
        )}
      </div>
      <figcaption>{image.width} × {image.height} · 预览</figcaption>
    </figure>
  )
})

/** Receives only the shared collector's bounded, validated previews. No file
 * reads, provider URLs, image decoding, reveal characters or scroll effects. */
export const ToolResultImages = memo(function ToolResultImages({ toolId, images, notice }: {
  toolId: string
  images?: ToolResultImage[]
  notice?: string
}): ReactElement | null {
  if (!images?.length && !notice) return null
  return (
    <div className="tool-result-images" role="group" aria-label="工具结果图片预览">
      {Boolean(images?.length) && (
        <div className="tool-result-image-grid">
          {images?.map((image, index) => (
            <ToolImagePreview key={`${toolId}:${image.partIndex}`} image={image} number={index + 1} />
          ))}
        </div>
      )}
      {notice && <p className="tool-image-notice">{notice}</p>}
    </div>
  )
})
